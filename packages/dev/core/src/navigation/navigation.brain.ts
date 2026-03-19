import {
    ActivationFunctions,
    Glorot,
    IMlpGraph,
    LayerConnectionBuilder,
    LayerConnectionType,
    MLPInferenceRuntime,
    MlpSynapse,
    PerceptronBuilder,
    SynapseBuilder,
} from "@spiky-panda/core";

import {
    INavigatorBrain,
    INavigatorBrainOptions,
    INavigatorInputTensor,
    INavigatorGoal,
    INavigationCommand,
    NAVIGATOR_INPUT_COUNT,
    NAVIGATOR_OUTPUT_COUNT,
} from "./navigation.interfaces";

/**
 * Default navigator brain configuration.
 */
const DEFAULT_CONFIG: INavigatorBrainOptions = {
    hiddenSize: 32,
    inferenceRateHz: 100,
    riskEscalationThreshold: 0.8,
};

/**
 * Maximum steering angle in radians (~30°).
 * MLP output [0,1] is mapped to [−MAX_STEER, +MAX_STEER].
 */
const MAX_STEER_RAD = Math.PI / 6;

/**
 * MLP-based reactive navigation brain.
 *
 * **Architecture: 55 → 32 → 4**
 *
 * - **Input layer** (55 neurons, linear activation):
 *   Flat sensor tensor passed through unchanged. All values are
 *   expected pre-normalized to ~[−1,1] by the `INavigatorNode` that
 *   owns this brain.
 *
 * - **Hidden layer** (32 neurons, tanh activation):
 *   Tanh ∈ [−1,+1] was chosen over ReLU for the same reasons as
 *   `CreatureBrain`: sensor values are symmetric around 0 (e.g.,
 *   "obstacle to the left" = negative, "right" = positive), and
 *   bounded activations prevent explosion under weight mutation.
 *   32 neurons give ~1.9k parameters — enough to learn obstacle
 *   avoidance + goal tracking while keeping inference < 0.1ms.
 *
 * - **Output layer** (4 neurons, sigmoid activation):
 *   Sigmoid ∈ [0,1] maps naturally to motor controls:
 *     [0] steering:  0.5 = straight, 0/1 = max left/right
 *     [1] throttle:  0 = stopped, 1 = max forward
 *     [2] brake:     0 = coasting, 1 = full brake
 *     [3] risk:      0 = safe, 1 = critical → escalate to MCP
 *
 * **Weight initialization**: Glorot (Xavier) — identical to CreatureBrain.
 * Keeps activations from saturating at generation 0.
 *
 * **Total trainable parameters**:
 *   55×32 + 32×4 weights + 32 + 4 biases = 1,924
 */
export class NavigatorBrain implements INavigatorBrain {
    /**
     * Factory: builds a fresh 55→N→4 MLP graph with Glorot-initialized weights.
     * Architecture mirrors CreatureBrain.createCreatureGraph() but with
     * a configurable hidden size (default 32).
     */
    static createNavigatorGraph(hiddenSize: number = DEFAULT_CONFIG.hiddenSize): IMlpGraph {
        const createConnBuilder = function (fanin: number, fanout: number) {
            const synapseBuilder = new SynapseBuilder().withType(MlpSynapse) as SynapseBuilder;
            return new LayerConnectionBuilder().withSynapseBuilder(synapseBuilder).withType(LayerConnectionType.FullyConnected).withWeightInitializer(new Glorot(fanin, fanout));
        };

        const builder = new PerceptronBuilder()
            .withInputLayer(NAVIGATOR_INPUT_COUNT, 0, ActivationFunctions.linear) // 55 sensors, pass-through
            .withHiddenLayer(hiddenSize, 0, ActivationFunctions.tanh) // tanh ∈ [−1,+1]
            .withConnectionBuilder(createConnBuilder(NAVIGATOR_INPUT_COUNT, hiddenSize))
            .withOutputLayer(NAVIGATOR_OUTPUT_COUNT, 0, ActivationFunctions.sigmoid) // 4 outputs ∈ [0,1]
            .withConnectionBuilder(createConnBuilder(hiddenSize, NAVIGATOR_OUTPUT_COUNT));

        return builder.build();
    }

    private _graph: IMlpGraph;
    private _runtime: MLPInferenceRuntime;
    private _config: INavigatorBrainOptions;
    private _goal: INavigatorGoal | null = null;

    /**
     * @param config  Brain configuration (hidden size, inference rate, thresholds).
     * @param other   If provided, copies all weights and biases from the source
     *                brain — used for cloning or checkpoint restoration.
     */
    public constructor(config?: Partial<INavigatorBrainOptions>, other?: INavigatorBrain) {
        this._config = { ...DEFAULT_CONFIG, ...config };
        this._graph = NavigatorBrain.createNavigatorGraph(this._config.hiddenSize);

        if (other) {
            // Copy synapse weights from source → this graph.
            const srcLinks = other.graph.links;
            const dstLinks = this._graph.links;
            for (let i = 0; i < srcLinks.length && i < dstLinks.length; i++) {
                dstLinks[i].weight = srcLinks[i].weight;
            }

            // Copy neuron biases from source → this graph.
            const srcNodes = other.graph.nodes;
            const dstNodes = this._graph.nodes;
            for (let i = 0; i < srcNodes.length && i < dstNodes.length; i++) {
                dstNodes[i].bias = srcNodes[i].bias;
            }
        }

        // Pre-compile the inference runtime for fast per-tick evaluation.
        this._runtime = new MLPInferenceRuntime(this._graph);
    }

    public get graph(): IMlpGraph {
        return this._graph;
    }

    public get runtime(): MLPInferenceRuntime {
        return this._runtime;
    }

    public get config(): INavigatorBrainOptions {
        return this._config;
    }

    public get goal(): INavigatorGoal | null {
        return this._goal;
    }

    /**
     * Raw feed-forward inference.
     * @param input  Float array of length 55 (NAVIGATOR_INPUT_COUNT).
     * @returns      Float array of length 4: [steering, throttle, brake, risk].
     */
    public evaluate(input: number[]): number[] {
        return this._runtime.run(input);
    }

    /**
     * Structured inference: accepts a typed input tensor, flattens it,
     * runs the MLP, and returns a motor-ready `INavigationCommand`.
     */
    public evaluateCommand(input: INavigatorInputTensor): INavigationCommand {
        const flat = NavigatorBrain.flattenInput(input);
        const raw = this.evaluate(flat);

        const steering = raw[0]; // [0,1] — 0.5 = straight
        const throttle = raw[1]; // [0,1]
        const brake = raw[2]; // [0,1]
        const risk = raw[3]; // [0,1]

        return {
            // Map sigmoid [0,1] → [−MAX_STEER, +MAX_STEER] radians.
            // 0.5 → 0 rad (straight), 0 → −MAX (left), 1 → +MAX (right).
            steeringAngle: (steering - 0.5) * 2 * MAX_STEER_RAD,
            throttle,
            brake,
            risk,
            escalate: risk >= this._config.riskEscalationThreshold,
        };
    }

    /**
     * Replace all weights from a serialized weight set.
     * Delegates to the `IWeightLoader` provided in options.
     * The MCP strategic layer calls this to swap behaviors
     * (e.g., road-trained vs off-road-trained weights).
     */
    public async loadWeights(uri: string): Promise<void> {
        const loader = this._config.weightLoader;
        if (!loader) {
            throw new Error("No IWeightLoader configured — cannot load weights from URI: " + uri);
        }

        const { weights, biases } = await loader.load(uri);

        // Apply deserialized weights to synapse links.
        const links = this._graph.links;
        for (let i = 0; i < links.length && i < weights.length; i++) {
            links[i].weight = weights[i];
        }

        // Apply deserialized biases to neuron nodes.
        const nodes = this._graph.nodes;
        for (let i = 0; i < nodes.length && i < biases.length; i++) {
            nodes[i].bias = biases[i];
        }

        // Recompile the inference runtime with the new weights.
        this._runtime = new MLPInferenceRuntime(this._graph);
    }

    public setGoal(goal: INavigatorGoal): void {
        this._goal = goal;
    }

    /**
     * Flatten a structured input tensor into a float[] for the MLP.
     *
     * Layout (55 floats):
     *   [0..5]   pose (6)
     *   [6..11]  imu (6)
     *   [12..47] lidar sectors (36)
     *   [48..51] wheel slip (4, zero-padded if fewer wheels)
     *   [52..54] goal vector (3)
     */
    static flattenInput(input: INavigatorInputTensor): number[] {
        const flat = new Array<number>(NAVIGATOR_INPUT_COUNT);
        let offset = 0;

        // Pose & velocity (6)
        for (let i = 0; i < 6; i++) flat[offset++] = input.pose[i];

        // IMU snapshot (6)
        for (let i = 0; i < 6; i++) flat[offset++] = input.imu[i];

        // Lidar sectors (36)
        for (let i = 0; i < 36; i++) flat[offset++] = input.lidarSectors[i] ?? 0;

        // Wheel slip (4, zero-padded)
        for (let i = 0; i < 4; i++) flat[offset++] = input.wheelSlip[i] ?? 0;

        // Goal vector (3)
        for (let i = 0; i < 3; i++) flat[offset++] = input.goal[i];

        return flat;
    }
}
