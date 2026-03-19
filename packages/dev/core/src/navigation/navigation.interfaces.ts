import { IMlpGraph, MLPInferenceRuntime } from "@spiky-panda/core";
import { IRecord } from "@dev/core/telemetry";
import { ISensorEventEmitter, ISensorNode, ISensorReadable } from "@dev/core/perception";
import { IDifferentialOdometryNode } from "@dev/core/perception";

// ---------------------------------------------------------------------------
// Input tensor
// ---------------------------------------------------------------------------

/**
 * Number of angular sectors the lidar depth grid is downsampled into
 * for the MLP input. Each sector holds the minimum depth value within
 * its angular range, giving a compact 1-D "distance ring" around the agent.
 */
export const NAVIGATOR_LIDAR_SECTORS = 36;

/**
 * Total MLP input size.
 *
 * Layout (all values normalized to ~[−1,1] or [0,1]):
 *   [0..5]   pose & velocity   — x, y, theta, vx, vy, omega        (6)
 *   [6..11]  IMU snapshot       — ax, ay, az, gx, gy, gz            (6)
 *   [12..47] lidar sectors      — min depth per 10° sector           (36)
 *   [48..51] wheel slip         — slip ratio per wheel (up to 4)     (4)
 *   [52..54] goal vector        — relative dx, dy, dtheta to target  (3)
 *
 *   Total: 55
 */
export const NAVIGATOR_INPUT_COUNT = 55;

/**
 * MLP output size.
 *
 * Layout (all values in [0,1] via sigmoid):
 *   [0] steering  — 0.5 = straight, 0/1 = max left/right
 *   [1] throttle  — 0 = stopped, 1 = max forward
 *   [2] brake     — 0 = no braking, 1 = full brake
 *   [3] risk      — 0 = safe, 1 = critical (triggers MCP escalation)
 *
 *   Total: 4
 */
export const NAVIGATOR_OUTPUT_COUNT = 4;

/**
 * Structured view of the MLP input tensor.
 * Implementations flatten this into a float[] for inference.
 */
export interface INavigatorInputTensor {
    /** Fused pose & velocity: x, y, theta, vx, vy, omega. */
    pose: [number, number, number, number, number, number];

    /** Raw IMU snapshot: ax, ay, az, gx, gy, gz. */
    imu: [number, number, number, number, number, number];

    /** Downsampled lidar depth per angular sector (NAVIGATOR_LIDAR_SECTORS values). */
    lidarSectors: number[];

    /** Per-wheel slip ratios (0 = grip, 1 = full slip). Up to 4 wheels. */
    wheelSlip: number[];

    /** Relative vector to current goal: dx, dy, dtheta. */
    goal: [number, number, number];
}

/**
 * Structured view of the MLP output tensor.
 */
export interface INavigatorOutputTensor {
    /** Steering: 0.5 = straight, 0 = max left, 1 = max right. */
    steering: number;

    /** Throttle: 0 = stopped, 1 = max forward. */
    throttle: number;

    /** Brake: 0 = no braking, 1 = full brake. */
    brake: number;

    /**
     * Risk score: 0 = safe, 1 = critical.
     * When above `riskEscalationThreshold`, the MCP strategic layer
     * is notified to intervene (re-route, override, request human input).
     */
    risk: number;
}

// ---------------------------------------------------------------------------
// Navigation command (downstream-consumable action)
// ---------------------------------------------------------------------------

/**
 * Motor-level command derived from the MLP output,
 * ready for consumption by actuators or a motor controller.
 */
export interface INavigationCommand {
    /** Steering angle in radians (negative = left, positive = right). */
    steeringAngle: number;

    /** Forward force ratio [0,1]. */
    throttle: number;

    /** Braking force ratio [0,1]. */
    brake: number;

    /** Risk level reported by the brain. */
    risk: number;

    /** True when risk exceeds the escalation threshold. */
    escalate: boolean;
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

/**
 * Target waypoint the navigator should steer toward.
 * Expressed in the same local frame as the odometry estimate.
 */
export interface INavigatorGoal {
    /** Target x in meters. */
    x: number;

    /** Target y in meters. */
    y: number;

    /** Target heading in radians (NaN if heading is unconstrained). */
    theta: number;
}

// ---------------------------------------------------------------------------
// Weight loading
// ---------------------------------------------------------------------------

/**
 * Strategy for deserializing MLP weights from a URI.
 * Implementations handle the transport (file, HTTP, IndexedDB…)
 * and format (JSON, binary, protobuf…) so the brain stays transport-agnostic.
 */
export interface IWeightLoader {
    /**
     * Load weights and biases from the given URI.
     * @param uri  Location of the serialized weight set.
     * @returns    Deserialized weights and biases arrays.
     */
    load(uri: string): Promise<{ weights: number[]; biases: number[] }>;
}

// ---------------------------------------------------------------------------
// MLP options
// ---------------------------------------------------------------------------

/**
 * Options for the navigator MLP.
 * Mirrors the CreatureBrain pattern: architecture is fixed at build time,
 * but weights can be swapped at runtime via the weight loader.
 */
export interface INavigatorBrainOptions {
    /**
     * Hidden layer neuron count.
     * Default: 32 (sweet spot for ~55 inputs and 4 outputs).
     */
    hiddenSize: number;

    /**
     * Inference rate in Hz.
     * The brain runs at this frequency, independent of the simulation tick rate.
     * Sensor data is sampled/interpolated to match. Default: 100.
     */
    inferenceRateHz: number;

    /**
     * Risk score above which the `escalate` flag is set on the
     * navigation command, notifying the MCP layer. Default: 0.8.
     */
    riskEscalationThreshold: number;

    /** URI to a serialized weight set (JSON or binary). Optional. */
    weightsUri?: string;

    /**
     * Strategy for loading weights from a URI.
     * If not provided, `loadWeights()` will throw until one is set.
     */
    weightLoader?: IWeightLoader;
}

// ---------------------------------------------------------------------------
// Navigator brain interface
// ---------------------------------------------------------------------------

/**
 * The local MLP brain for reactive navigation.
 *
 * **Architecture: 55 → 32 → 4 (MLP)**
 *
 * - **Input layer** (55 neurons, linear activation):
 *   Receives the flattened `INavigatorInputTensor` — already normalized.
 *   Linear pass-through preserves sensor fidelity.
 *
 * - **Hidden layer** (32 neurons, tanh activation):
 *   Tanh matches the [−1,+1] sensor distribution and provides symmetric
 *   response to directional inputs (obstacle left vs right).
 *   32 neurons give enough capacity for obstacle avoidance + path tracking
 *   while staying under 2k parameters for sub-ms inference.
 *
 * - **Output layer** (4 neurons, sigmoid activation):
 *   Sigmoid ∈ [0,1] maps to steering, throttle, brake, risk.
 *   Bounded outputs prevent runaway motor commands.
 *
 * Total trainable parameters: 55×32 + 32×4 weights + 32 + 4 biases = 1,924
 *
 * The MCP strategic layer manages this brain by:
 * - Setting/updating the goal vector via `setGoal()`
 * - Swapping weight sets via `loadWeights()` for terrain adaptation
 * - Reading the `escalate` flag to decide when to intervene
 */
export interface INavigatorBrain {
    /** The underlying MLP graph (for weight inspection, mutation, serialization). */
    readonly graph: IMlpGraph;

    /** Pre-compiled inference runtime for fast per-tick evaluation. */
    readonly runtime: MLPInferenceRuntime;

    /** Current brain configuration. */
    readonly config: INavigatorBrainOptions;

    /**
     * Feed-forward inference: sensor tensor → navigation output.
     * This is the hot path — called at `inferenceRateHz`.
     *
     * @param input  Flattened float array of length NAVIGATOR_INPUT_COUNT (55).
     * @returns      Float array of length NAVIGATOR_OUTPUT_COUNT (4):
     *               [steering, throttle, brake, risk].
     */
    evaluate(input: number[]): number[];

    /**
     * Build a structured `INavigationCommand` from raw MLP output,
     * applying scaling (e.g., steering → radians) and the escalation threshold.
     */
    evaluateCommand(input: INavigatorInputTensor): INavigationCommand;

    /**
     * Replace the current weights with a serialized weight set.
     * Used by the MCP layer to swap behaviors (e.g., road vs off-road).
     */
    loadWeights(uri: string): Promise<void>;

    /** Set or update the target waypoint. */
    setGoal(goal: INavigatorGoal): void;

    /** Current goal (readonly). */
    readonly goal: INavigatorGoal | null;
}

// ---------------------------------------------------------------------------
// Sensor node integration
// ---------------------------------------------------------------------------

export interface INavigationCommandEvent extends IRecord<INavigationCommand> {}

/**
 * Navigator sensor node: lives in the simulation graph, consumes
 * upstream sensors each tick, runs the MLP, and emits navigation commands.
 *
 * `onTick(dtMs)` is the integration point:
 *   1. Read IMU, lidar, odometry, wheel encoders
 *   2. Flatten into input tensor
 *   3. Run MLP inference
 *   4. Emit INavigationCommand via sensor event
 */
export interface INavigatorNode extends ISensorNode, ISensorReadable<INavigationCommand>, ISensorEventEmitter<INavigationCommandEvent> {
    /** The MLP brain performing reactive inference. */
    readonly brain: INavigatorBrain;

    /** Fused odometry source. */
    readonly odometry: IDifferentialOdometryNode;

    /** Set the navigation target. */
    setGoal(goal: INavigatorGoal): void;
}
