import { IMlpGraph, MLPInferenceRuntime } from "@spiky-panda/core";
import { IRecord } from "@dev/core/telemetry";
import { ISensorEventEmitter, ISensorNode, ISensorReadable } from "@dev/core/perception";
import { IDifferentialOdometryNode } from "@dev/core/perception";

// ═══════════════════════════════════════════════════════════════════════════
// Constants — Perception MLP (MLP-Percept)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Number of angular sectors the lidar depth grid is downsampled into
 * for the perception MLP input. Each sector holds the minimum depth value
 * within its angular range, giving a compact 1-D "distance ring" around
 * the agent.
 */
export const NAVIGATOR_LIDAR_SECTORS = 36;

/**
 * Perception MLP input size.
 *
 * The perception brain receives raw spatial sensors only — it answers
 * "what's around me?" without knowing about pose, goal, or wheels.
 *
 * Layout (all values normalized to ~[−1,1] or [0,1]):
 *   [0..35]  lidar sectors  — min depth per 10° sector            (36)
 *   [36..41] IMU snapshot   — ax, ay, az, gx, gy, gz              (6)
 *
 *   Total: 42
 */
export const PERCEPT_INPUT_COUNT = 42;

/**
 * Number of learned features the perception MLP outputs.
 *
 * Each output neuron has a formal definition — see `PerceptFeatureIndex`
 * for the full specification with ground truth computations:
 *
 *   [0] frontObstacleProximity — 0 (far) → 1 (contact)
 *   [1] frontObstacleBearing   — −1 (left) → +1 (right)
 *   [2] leftClearance          — 0 (wall) → 1 (open)
 *   [3] rightClearance         — 0 (wall) → 1 (open)
 *   [4] closingRate            — −1 (approaching) → +1 (receding)
 *   [5] corridorDirection      — −1 (left) → +1 (right)
 *   [6] terrainRoughness       — 0 (smooth) → 1 (rough)
 *   [7] confidence             — 0 (unreliable) → 1 (high trust)
 *
 * 8 features is a sweet spot: enough to encode the spatial situation,
 * compact enough to be a clean input for the decision MLP.
 */
export const PERCEPT_OUTPUT_COUNT = 8;

// ═══════════════════════════════════════════════════════════════════════════
// Constants — Decision MLP (MLP-Decide)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decision MLP input size.
 *
 * The decision brain receives the perception features plus ego-state
 * and goal — it answers "what do I do?"
 *
 * Layout (all values normalized to ~[−1,1] or [0,1]):
 *   [0..7]   percept features — learned from MLP-Percept              (8)
 *   [8..13]  pose & velocity  — x, y, theta, vx, vy, omega           (6)
 *   [14..17] wheel slip       — slip ratio per wheel (up to 4)        (4)
 *   [18..20] goal vector      — relative dx, dy, dtheta to target     (3)
 *
 *   Total: 21
 */
export const DECIDE_INPUT_COUNT = 21;

/**
 * Decision MLP output size.
 *
 * Layout (all values in [0,1] via sigmoid):
 *   [0] steering  — 0.5 = straight, 0/1 = max left/right
 *   [1] throttle  — 0 = stopped, 1 = max forward
 *   [2] brake     — 0 = no braking, 1 = full brake
 *   [3] risk      — 0 = safe, 1 = critical (triggers MCP escalation)
 *
 *   Total: 4
 */
export const DECIDE_OUTPUT_COUNT = 4;

/**
 * Legacy constant — total flattened input size for the full cascade.
 * Kept for backward compatibility. Equals PERCEPT_INPUT_COUNT + 6 (pose) + 4 (slip) + 3 (goal).
 */
export const NAVIGATOR_INPUT_COUNT = 55;

/** Legacy constant — final output size. Same as DECIDE_OUTPUT_COUNT. */
export const NAVIGATOR_OUTPUT_COUNT = DECIDE_OUTPUT_COUNT;

// ═══════════════════════════════════════════════════════════════════════════
// Input / output tensor interfaces
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Structured input for the perception MLP.
 * Contains only spatial/inertial data — no ego-state or goal.
 */
export interface IPerceptInputTensor {
    /** Downsampled lidar depth per angular sector (NAVIGATOR_LIDAR_SECTORS values). */
    lidarSectors: number[];

    /** Raw IMU snapshot: ax, ay, az, gx, gy, gz. */
    imu: [number, number, number, number, number, number];
}

/**
 * Output of the perception MLP — learned environment features.
 *
 * Each index has a formal definition used to generate supervised training
 * labels. During end-to-end evolutionary training the features may drift
 * from these definitions toward whatever representation best serves the
 * decision cortex.
 *
 * **Ground truth computations** (for training set generation):
 *
 * The 36 LiDAR sectors span the horizontal FOV:
 *   - Sectors 0–8:   left quadrant
 *   - Sectors 9–17:  front-left
 *   - Sectors 18–26: front-right
 *   - Sectors 27–35: right quadrant
 *   - "Front sectors" = 9–26 (central 180°)
 */
export interface IPerceptOutputTensor {
    /**
     * Raw feature vector (length = PERCEPT_OUTPUT_COUNT = 8).
     * Use the named accessors below for semantic clarity, or this
     * array for batch processing and MLP I/O.
     */
    features: number[];
}

// ─── Named perception output indices ─────────────────────────────────────────

/**
 * Indices into the `IPerceptOutputTensor.features` array.
 * Each constant maps to a formally defined perception output.
 */
export const enum PerceptFeatureIndex {
    /**
     * **Front obstacle proximity** — range [0, 1]
     *
     * How close the nearest obstacle in the front sectors (9–26) is.
     * - 0.0 = nothing within maxRange
     * - 1.0 = contact / zero distance
     *
     * Ground truth: `clamp(1.0 − min(depth[9..26]) / maxRange, 0, 1)`
     */
    FrontObstacleProximity = 0,

    /**
     * **Front obstacle bearing** — range [−1, +1]
     *
     * Angular position of the nearest front obstacle relative to heading.
     * - −1.0 = hard left
     * -  0.0 = dead center
     * - +1.0 = hard right
     *
     * Ground truth: weighted angular centroid of front obstacles below a
     * distance threshold, using inverse-depth weighting:
     * ```
     * For each front sector i where depth[i] < threshold:
     *     sum += angle[i] × (1 / depth[i])
     *     w   += (1 / depth[i])
     * centroid = sum / w
     * output   = clamp(centroid / halfFov, −1, +1)
     * ```
     */
    FrontObstacleBearing = 1,

    /**
     * **Left clearance** — range [0, 1]
     *
     * Average free space on the left side (sectors 0–8).
     * - 0.0 = wall / fully blocked
     * - 1.0 = wide open
     *
     * Ground truth: `clamp(mean(depth[0..8]) / maxRange, 0, 1)`
     */
    LeftClearance = 2,

    /**
     * **Right clearance** — range [0, 1]
     *
     * Average free space on the right side (sectors 27–35).
     * - 0.0 = wall / fully blocked
     * - 1.0 = wide open
     *
     * Ground truth: `clamp(mean(depth[27..35]) / maxRange, 0, 1)`
     */
    RightClearance = 3,

    /**
     * **Closing rate** — range [−1, +1]
     *
     * Rate of approach to the nearest front obstacle.
     * - −1.0 = approaching fast
     * -  0.0 = static / no relative motion
     * - +1.0 = receding fast
     *
     * Ground truth (two methods, pick based on available data):
     * - IMU-based:  `dot(linearAccel, forwardUnitVector) / maxAccel`
     * - Depth-based: `(prevMinFrontDepth − currMinFrontDepth) / (dt × maxSpeed)`
     *
     * Output: `clamp(value, −1, +1)`
     */
    ClosingRate = 4,

    /**
     * **Corridor direction** — range [−1, +1]
     *
     * Direction of the most open corridor (deepest depth reading).
     * - −1.0 = best path is hard left
     * -  0.0 = straight ahead
     * - +1.0 = best path is hard right
     *
     * Ground truth:
     * ```
     * bestSector = argmax(depth[0..35])
     * bestAngle  = angle[bestSector]
     * output     = clamp(bestAngle / halfFov, −1, +1)
     * ```
     */
    CorridorDirection = 5,

    /**
     * **Terrain roughness** — range [0, 1]
     *
     * Vibration intensity derived from IMU accelerometer.
     * - 0.0 = smooth surface
     * - 1.0 = very rough terrain
     *
     * Ground truth:
     * ```
     * window   = last N IMU acceleration samples (e.g., N = 10)
     * variance = var(‖accel‖ for each sample in window)
     * output   = clamp(variance / maxVariance, 0, 1)
     * ```
     */
    TerrainRoughness = 6,

    /**
     * **Confidence** — range [0, 1]
     *
     * Overall reliability of the perception reading.
     * - 0.0 = unreliable (noisy, contradictory, saturated)
     * - 1.0 = high trust
     *
     * Ground truth (factors that reduce confidence):
     * - High variance across adjacent LiDAR sectors (noisy returns)
     * - IMU readings near sensor limits (saturated accelerometer)
     * - Large discrepancy between IMU-derived motion and encoder-derived motion
     *
     * `output = 1.0 − clamp(combined_noise_score, 0, 1)`
     */
    Confidence = 7,
}

/**
 * Structured input for the decision MLP.
 * Combines perception features with ego-state and goal.
 */
export interface IDecideInputTensor {
    /** Learned environment features from MLP-Percept (8 values). */
    perceptFeatures: number[];

    /** Fused pose & velocity: x, y, theta, vx, vy, omega. */
    pose: [number, number, number, number, number, number];

    /** Per-wheel slip ratios (0 = grip, 1 = full slip). Up to 4 wheels. */
    wheelSlip: number[];

    /** Relative vector to current goal: dx, dy, dtheta. */
    goal: [number, number, number];
}

/**
 * Full structured input tensor for the cascaded navigator.
 * The `INavigatorNode` builds this from raw sensor reads, then the
 * `INavigatorBrain` splits it into percept + decide stages.
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
 * Structured view of the final MLP output tensor (from MLP-Decide).
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

// ═══════════════════════════════════════════════════════════════════════════
// Navigation command (downstream-consumable action)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Motor-level command derived from the MLP cascade output,
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

// ═══════════════════════════════════════════════════════════════════════════
// Goal
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Weight loading
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// MLP options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for the cascaded navigator MLP.
 *
 * The cascade consists of two independent MLPs:
 *
 * 1. **MLP-Percept** (42 → perceptHiddenSize → perceptOutputSize):
 *    Compresses raw spatial data (lidar + IMU) into learned features.
 *
 * 2. **MLP-Decide** (21 → decisionHiddenSize → 4):
 *    Maps perception features + ego-state + goal to motor commands.
 *
 * Both share the same `IWeightLoader` for serialization but maintain
 * independent weight sets. Weights can be swapped independently via
 * `loadPerceptWeights()` and `loadDecisionWeights()`.
 */
export interface INavigatorBrainOptions {
    /**
     * Perception MLP hidden layer neuron count.
     * Default: 16 — enough to extract obstacle features from 42 inputs.
     */
    perceptHiddenSize: number;

    /**
     * Number of learned features the perception MLP outputs.
     * Default: 8 (PERCEPT_OUTPUT_COUNT).
     */
    perceptOutputSize: number;

    /**
     * Decision MLP hidden layer neuron count.
     * Default: 16 — enough to map 21 inputs (features + state + goal)
     * to 4 motor outputs.
     */
    decisionHiddenSize: number;

    /**
     * Inference rate in Hz.
     * Both MLPs run in cascade at this frequency. Default: 100.
     */
    inferenceRateHz: number;

    /**
     * Risk score above which the `escalate` flag is set on the
     * navigation command, notifying the MCP layer. Default: 0.8.
     */
    riskEscalationThreshold: number;

    /** URI to perception MLP weights. Optional. */
    perceptWeightsUri?: string;

    /** URI to decision MLP weights. Optional. */
    decisionWeightsUri?: string;

    /**
     * Strategy for loading weights from a URI.
     * Shared by both MLPs. If not provided, `loadWeights()` will throw.
     */
    weightLoader?: IWeightLoader;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-brain interfaces
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The perception sub-brain: MLP-Percept.
 *
 * **Architecture: 42 → 16 → 8**
 *
 * - **Input** (42 neurons, linear): LiDAR sectors (36) + IMU (6).
 *   Raw spatial data passed through unchanged.
 *
 * - **Hidden** (16 neurons, tanh): Learns to extract obstacle/environment
 *   features from the raw depth + inertial signal. Tanh provides symmetric
 *   response ("obstacle left" vs "obstacle right").
 *
 * - **Output** (8 neurons, tanh): Learned features in [−1, +1].
 *   Tanh (not sigmoid) because features are intermediate values fed into
 *   MLP-Decide — symmetric range preserves directional information.
 *
 * Total params: 42×16 + 16×8 weights + 16 + 8 biases = **824**
 */
export interface IPerceptCortex {
    /** The underlying MLP graph. */
    readonly graph: IMlpGraph;

    /** Pre-compiled inference runtime. */
    readonly runtime: MLPInferenceRuntime;

    /**
     * Raw feed-forward: spatial sensors → learned features.
     * @param input  Float array of length PERCEPT_INPUT_COUNT (42).
     * @returns      Float array of length PERCEPT_OUTPUT_COUNT (8).
     */
    evaluate(input: number[]): number[];

    /**
     * Replace weights from a serialized weight set.
     */
    loadWeights(uri: string, loader: IWeightLoader): Promise<void>;
}

/**
 * The decision sub-brain: MLP-Decide.
 *
 * **Architecture: 21 → 16 → 4**
 *
 * - **Input** (21 neurons, linear): Perception features (8) + pose (6) +
 *   wheel slip (4) + goal (3). Clean, learned features from MLP-Percept
 *   replace the raw 36-sector depth grid — a much easier signal to learn from.
 *
 * - **Hidden** (16 neurons, tanh): Learns the control policy. 16 neurons
 *   are sufficient because the input is already heavily processed (8 features
 *   instead of 36 raw sectors).
 *
 * - **Output** (4 neurons, sigmoid): Steering, throttle, brake, risk in [0,1].
 *   Sigmoid bounds all outputs to valid motor command ranges.
 *
 * Total params: 21×16 + 16×4 weights + 16 + 4 biases = **420**
 */
export interface IDecisionCortex {
    /** The underlying MLP graph. */
    readonly graph: IMlpGraph;

    /** Pre-compiled inference runtime. */
    readonly runtime: MLPInferenceRuntime;

    /**
     * Raw feed-forward: features + state + goal → motor outputs.
     * @param input  Float array of length DECIDE_INPUT_COUNT (21).
     * @returns      Float array of length DECIDE_OUTPUT_COUNT (4):
     *               [steering, throttle, brake, risk].
     */
    evaluate(input: number[]): number[];

    /**
     * Replace weights from a serialized weight set.
     */
    loadWeights(uri: string, loader: IWeightLoader): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cascaded navigator brain interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The cascaded MLP brain for reactive navigation.
 *
 * **Architecture: [42 → 16 → 8] → [21 → 16 → 4]**
 *
 * Two independent MLPs run in cascade on every tick:
 *
 * ```
 * LiDAR sectors (36) ──┐
 * IMU snapshot (6)    ──┤
 *                       ▼
 *               ┌──────────────┐
 *               │  MLP-Percept  │  "What's around me?"
 *               │  42 → 16 → 8 │  824 params
 *               └──────┬───────┘
 *                      │ 8 learned features
 *                      ▼
 * Pose/velocity (6)  ──┐
 * Wheel slip (4)     ──┤
 * Goal vector (3)    ──┤
 * Percept output (8) ──┤
 *                      ▼
 *               ┌──────────────┐
 *               │  MLP-Decide   │  "What do I do?"
 *               │  21 → 16 → 4 │  420 params
 *               └──────┬───────┘
 *                      ▼
 *               steering, throttle, brake, risk
 * ```
 *
 * **Total trainable parameters**: 824 + 420 = **1,244**
 *
 * **Why cascaded?**
 *
 * - **Learned features > raw depth**: MLP-Percept compresses 36 depth
 *   sectors into 8 meaningful signals. The decision MLP gets a cleaner
 *   input than raw sensor data.
 *
 * - **Each MLP stays small and trainable**: fewer params per network
 *   means faster convergence during training/evolution and less overfitting.
 *
 * - **Independent training**: perception can be trained on "label the
 *   obstacles" tasks, then frozen while the decision MLP evolves on
 *   "reach the goal" tasks. Or swap perception models for different
 *   sensor configs without retraining the control policy.
 *
 * - **Interpretable intermediate layer**: the 8 percept outputs are
 *   loggable, visualizable features. "Why did it turn left?" →
 *   inspect the percept output, not 36 raw sectors.
 *
 * The MCP strategic layer manages this brain by:
 * - Setting/updating the goal vector via `setGoal()`
 * - Swapping weight sets independently via `loadPerceptWeights()` /
 *   `loadDecisionWeights()` for terrain adaptation
 * - Reading the `escalate` flag to decide when to intervene
 */
export interface INavigatorBrain {
    /** Perception sub-brain: spatial sensors → learned features. */
    readonly percept: IPerceptCortex;

    /** Decision sub-brain: features + state + goal → motor commands. */
    readonly decision: IDecisionCortex;

    /** Current brain configuration. */
    readonly config: INavigatorBrainOptions;

    /**
     * Full cascaded inference: raw sensor tensor → navigation output.
     * Internally runs MLP-Percept then MLP-Decide in sequence.
     *
     * @param input  Structured input tensor with all sensor data.
     * @returns      Motor-ready navigation command.
     */
    evaluateCommand(input: INavigatorInputTensor): INavigationCommand;

    /**
     * Access the latest perception features (output of MLP-Percept).
     * Useful for logging, debugging, and visualization.
     */
    readonly lastPerceptFeatures: number[] | null;

    /**
     * Replace perception MLP weights.
     * Used to swap obstacle detection models for different environments.
     */
    loadPerceptWeights(uri: string): Promise<void>;

    /**
     * Replace decision MLP weights.
     * Used to swap control policies (road vs off-road, calm vs aggressive).
     */
    loadDecisionWeights(uri: string): Promise<void>;

    /** Set or update the target waypoint. */
    setGoal(goal: INavigatorGoal): void;

    /** Current goal (readonly). */
    readonly goal: INavigatorGoal | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sensor node integration
// ═══════════════════════════════════════════════════════════════════════════

export interface INavigationCommandEvent extends IRecord<INavigationCommand> {}

/**
 * Navigator sensor node: lives in the simulation graph, consumes
 * upstream sensors each tick, runs the cascaded MLP, and emits
 * navigation commands.
 *
 * `onTick(dtMs)` is the integration point:
 *   1. Read IMU, lidar, odometry, wheel encoders
 *   2. Build INavigatorInputTensor
 *   3. Run MLP-Percept → learned features
 *   4. Run MLP-Decide → motor commands
 *   5. Emit INavigationCommand via sensor event
 */
export interface INavigatorNode extends ISensorNode, ISensorReadable<INavigationCommand>, ISensorEventEmitter<INavigationCommandEvent> {
    /** The cascaded MLP brain performing reactive inference. */
    readonly brain: INavigatorBrain;

    /** Fused odometry source. */
    readonly odometry: IDifferentialOdometryNode;

    /** Set the navigation target. */
    setGoal(goal: INavigatorGoal): void;
}
