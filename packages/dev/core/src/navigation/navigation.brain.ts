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
    IPerceptBrain,
    IDecisionBrain,
    IWeightLoader,
    PERCEPT_INPUT_COUNT,
    PERCEPT_OUTPUT_COUNT,
    DECIDE_INPUT_COUNT,
    DECIDE_OUTPUT_COUNT,
    NAVIGATOR_LIDAR_SECTORS,
} from "./navigation.interfaces";

// ═══════════════════════════════════════════════════════════════════════════
// Defaults
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default navigator brain configuration.
 */
const DEFAULT_CONFIG: INavigatorBrainOptions = {
    perceptHiddenSize: 16,
    perceptOutputSize: PERCEPT_OUTPUT_COUNT,
    decisionHiddenSize: 16,
    inferenceRateHz: 100,
    riskEscalationThreshold: 0.8,
};

/**
 * Maximum steering angle in radians (~30°).
 * MLP-Decide output [0,1] is mapped to [−MAX_STEER, +MAX_STEER].
 */
const MAX_STEER_RAD = Math.PI / 6;

// ═══════════════════════════════════════════════════════════════════════════
// Shared MLP graph builder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a Glorot-initialized fully-connected layer connection.
 *
 * @param fanin   Number of neurons in the source layer.
 * @param fanout  Number of neurons in the destination layer.
 * @returns       A configured `LayerConnectionBuilder`.
 */
function createConnBuilder(fanin: number, fanout: number): LayerConnectionBuilder {
    const synapseBuilder = new SynapseBuilder().withType(MlpSynapse) as SynapseBuilder;
    return new LayerConnectionBuilder()
        .withSynapseBuilder(synapseBuilder)
        .withType(LayerConnectionType.FullyConnected)
        .withWeightInitializer(new Glorot(fanin, fanout));
}

/**
 * Copy all weights and biases from a source graph to a destination graph.
 * Both graphs must have the same topology (same number of links and nodes).
 */
function copyGraphWeights(src: IMlpGraph, dst: IMlpGraph): void {
    const srcLinks = src.links;
    const dstLinks = dst.links;
    for (let i = 0; i < srcLinks.length && i < dstLinks.length; i++) {
        dstLinks[i].weight = srcLinks[i].weight;
    }

    const srcNodes = src.nodes;
    const dstNodes = dst.nodes;
    for (let i = 0; i < srcNodes.length && i < dstNodes.length; i++) {
        dstNodes[i].bias = srcNodes[i].bias;
    }
}

/**
 * Apply deserialized weights and biases to a graph, then recompile
 * the inference runtime.
 */
async function loadWeightsIntoGraph(
    graph: IMlpGraph,
    uri: string,
    loader: IWeightLoader
): Promise<MLPInferenceRuntime> {
    const { weights, biases } = await loader.load(uri);

    const links = graph.links;
    for (let i = 0; i < links.length && i < weights.length; i++) {
        links[i].weight = weights[i];
    }

    const nodes = graph.nodes;
    for (let i = 0; i < nodes.length && i < biases.length; i++) {
        nodes[i].bias = biases[i];
    }

    return new MLPInferenceRuntime(graph);
}

// ═══════════════════════════════════════════════════════════════════════════
// PerceptBrain — MLP-Percept implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Perception sub-brain: compresses raw spatial sensors into learned features.
 *
 * **Architecture: 42 → 16 → 8**
 *
 * - **Input** (42 neurons, linear):
 *   LiDAR sectors (36) + IMU (6). Raw spatial data passed through unchanged.
 *   Linear activation preserves sensor fidelity on pre-normalized values.
 *
 * - **Hidden** (16 neurons, tanh):
 *   Learns non-linear obstacle features from the raw depth + inertial signal.
 *   16 neurons is a sweet spot: enough capacity to distinguish obstacle
 *   patterns (wall vs gap vs approaching object) while keeping the network
 *   small enough for sub-0.05ms inference.
 *   Tanh ∈ [−1,+1] provides symmetric response — "obstacle left" produces
 *   a negative activation, "obstacle right" produces positive.
 *
 * - **Output** (8 neurons, tanh):
 *   Learned features in [−1,+1]. Tanh (not sigmoid) because these are
 *   **intermediate values** fed into MLP-Decide — symmetric range preserves
 *   directional information that sigmoid would squash.
 *
 * **Total trainable parameters**: 42×16 + 16×8 weights + 16 + 8 biases = **824**
 *
 * **Weight initialization**: Glorot (Xavier) — scales initial random weights
 * by sqrt(2/(fan_in + fan_out)) to keep activations from saturating at
 * generation 0.
 */
export class PerceptBrain implements IPerceptBrain {
    /**
     * Factory: builds a fresh 42→H→F MLP graph with Glorot-initialized weights.
     *
     * @param hiddenSize   Hidden layer neuron count. Default: 16.
     * @param outputSize   Feature output count. Default: 8.
     */
    static createPerceptGraph(
        hiddenSize: number = DEFAULT_CONFIG.perceptHiddenSize,
        outputSize: number = DEFAULT_CONFIG.perceptOutputSize
    ): IMlpGraph {
        const builder = new PerceptronBuilder()
            .withInputLayer(PERCEPT_INPUT_COUNT, 0, ActivationFunctions.linear)
            .withHiddenLayer(hiddenSize, 0, ActivationFunctions.tanh)
            .withConnectionBuilder(createConnBuilder(PERCEPT_INPUT_COUNT, hiddenSize))
            .withOutputLayer(outputSize, 0, ActivationFunctions.tanh) // tanh for intermediate features
            .withConnectionBuilder(createConnBuilder(hiddenSize, outputSize));

        return builder.build();
    }

    private _graph: IMlpGraph;
    private _runtime: MLPInferenceRuntime;

    /**
     * @param hiddenSize  Hidden layer size. Default: 16.
     * @param outputSize  Feature count. Default: 8.
     * @param other       If provided, copies all weights and biases from
     *                    the source brain (used for cloning/reproduction).
     */
    public constructor(
        hiddenSize: number = DEFAULT_CONFIG.perceptHiddenSize,
        outputSize: number = DEFAULT_CONFIG.perceptOutputSize,
        other?: IPerceptBrain
    ) {
        this._graph = PerceptBrain.createPerceptGraph(hiddenSize, outputSize);

        if (other) {
            copyGraphWeights(other.graph, this._graph);
        }

        this._runtime = new MLPInferenceRuntime(this._graph);
    }

    public get graph(): IMlpGraph {
        return this._graph;
    }

    public get runtime(): MLPInferenceRuntime {
        return this._runtime;
    }

    /**
     * Raw feed-forward: spatial sensors → learned features.
     * @param input  Float array of length 42 (PERCEPT_INPUT_COUNT).
     * @returns      Float array of length 8 (PERCEPT_OUTPUT_COUNT).
     */
    public evaluate(input: number[]): number[] {
        return this._runtime.run(input);
    }

    public async loadWeights(uri: string, loader: IWeightLoader): Promise<void> {
        this._runtime = await loadWeightsIntoGraph(this._graph, uri, loader);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DecisionBrain — MLP-Decide implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decision sub-brain: maps perception features + ego-state + goal
 * to motor commands.
 *
 * **Architecture: 21 → 16 → 4**
 *
 * - **Input** (21 neurons, linear):
 *   Perception features (8) + pose/velocity (6) + wheel slip (4) + goal (3).
 *   The input is already heavily processed — 8 learned features replace
 *   the original 36 raw depth sectors, giving the decision MLP a much
 *   cleaner signal to learn from.
 *
 * - **Hidden** (16 neurons, tanh):
 *   Learns the control policy: obstacle avoidance, goal tracking, speed
 *   regulation. 16 neurons suffice because the input is compact (21 vs
 *   the original 55 raw values). Tanh ∈ [−1,+1] provides symmetric
 *   response for left/right steering decisions.
 *
 * - **Output** (4 neurons, sigmoid):
 *   Sigmoid ∈ [0,1] maps naturally to motor controls:
 *     [0] steering:  0.5 = straight, 0/1 = max left/right
 *     [1] throttle:  0 = stopped, 1 = max forward
 *     [2] brake:     0 = coasting, 1 = full brake
 *     [3] risk:      0 = safe, 1 = critical → escalate to MCP
 *
 * **Total trainable parameters**: 21×16 + 16×4 weights + 16 + 4 biases = **420**
 *
 * **Why so few parameters?** Because MLP-Percept already did the hard work
 * of compressing 36 depth sectors into 8 meaningful features. The decision
 * MLP only needs to learn a mapping from a compact, high-level representation
 * to motor commands — a much simpler function than raw-sensor-to-action.
 */
export class DecisionBrain implements IDecisionBrain {
    /**
     * Factory: builds a fresh 21→H→4 MLP graph with Glorot-initialized weights.
     *
     * @param hiddenSize  Hidden layer neuron count. Default: 16.
     */
    static createDecisionGraph(hiddenSize: number = DEFAULT_CONFIG.decisionHiddenSize): IMlpGraph {
        const builder = new PerceptronBuilder()
            .withInputLayer(DECIDE_INPUT_COUNT, 0, ActivationFunctions.linear)
            .withHiddenLayer(hiddenSize, 0, ActivationFunctions.tanh)
            .withConnectionBuilder(createConnBuilder(DECIDE_INPUT_COUNT, hiddenSize))
            .withOutputLayer(DECIDE_OUTPUT_COUNT, 0, ActivationFunctions.sigmoid)
            .withConnectionBuilder(createConnBuilder(hiddenSize, DECIDE_OUTPUT_COUNT));

        return builder.build();
    }

    private _graph: IMlpGraph;
    private _runtime: MLPInferenceRuntime;

    /**
     * @param hiddenSize  Hidden layer size. Default: 16.
     * @param other       If provided, copies all weights and biases from
     *                    the source brain (used for cloning/reproduction).
     */
    public constructor(hiddenSize: number = DEFAULT_CONFIG.decisionHiddenSize, other?: IDecisionBrain) {
        this._graph = DecisionBrain.createDecisionGraph(hiddenSize);

        if (other) {
            copyGraphWeights(other.graph, this._graph);
        }

        this._runtime = new MLPInferenceRuntime(this._graph);
    }

    public get graph(): IMlpGraph {
        return this._graph;
    }

    public get runtime(): MLPInferenceRuntime {
        return this._runtime;
    }

    /**
     * Raw feed-forward: features + state → motor outputs.
     * @param input  Float array of length 21 (DECIDE_INPUT_COUNT).
     * @returns      Float array of length 4: [steering, throttle, brake, risk].
     */
    public evaluate(input: number[]): number[] {
        return this._runtime.run(input);
    }

    public async loadWeights(uri: string, loader: IWeightLoader): Promise<void> {
        this._runtime = await loadWeightsIntoGraph(this._graph, uri, loader);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// NavigatorBrain — cascaded MLP implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cascaded MLP-based reactive navigation brain.
 *
 * **Architecture: [42 → 16 → 8] → [21 → 16 → 4]**
 *
 * Two independent MLPs run in sequence on every tick:
 *
 * 1. **MLP-Percept** (42 → 16 → 8, 824 params):
 *    Compresses raw lidar sectors (36) + IMU (6) into 8 learned
 *    environment features. Output activation is tanh ∈ [−1,+1] to
 *    preserve directional information for the decision stage.
 *
 * 2. **MLP-Decide** (21 → 16 → 4, 420 params):
 *    Maps the 8 perception features + pose (6) + wheel slip (4) +
 *    goal (3) to motor commands. Output activation is sigmoid ∈ [0,1].
 *
 * **Total: 1,244 trainable parameters** (vs 1,924 in the monolithic design).
 *
 * **Benefits over monolithic 55→32→4:**
 *
 * - Fewer total parameters (1,244 vs 1,924) → faster training.
 * - Perception can be trained/frozen independently of decision.
 * - Intermediate features are interpretable and loggable.
 * - Swapping perception models doesn't require retraining the policy.
 *
 * **Inference latency**: ~0.1ms total for both MLPs (each is smaller
 * than the original single MLP, and they run sequentially — no
 * parallelism needed at these speeds).
 *
 * This class follows the same patterns as `CreatureBrain`:
 * - Glorot initialization for generation-0 readiness
 * - Weight copy constructor for cloning/reproduction
 * - Runtime recompilation on weight load
 * - Mutation support for evolutionary training
 */
export class NavigatorBrain implements INavigatorBrain {
    private _percept: PerceptBrain;
    private _decision: DecisionBrain;
    private _config: INavigatorBrainOptions;
    private _goal: INavigatorGoal | null = null;
    private _lastPerceptFeatures: number[] | null = null;

    /**
     * @param config  Brain configuration (layer sizes, inference rate, thresholds).
     * @param other   If provided, copies all weights from the source brain's
     *                percept and decision sub-brains (used for cloning).
     */
    public constructor(config?: Partial<INavigatorBrainOptions>, other?: INavigatorBrain) {
        this._config = { ...DEFAULT_CONFIG, ...config };

        this._percept = new PerceptBrain(
            this._config.perceptHiddenSize,
            this._config.perceptOutputSize,
            other?.percept
        );

        this._decision = new DecisionBrain(this._config.decisionHiddenSize, other?.decision);
    }

    public get percept(): IPerceptBrain {
        return this._percept;
    }

    public get decision(): IDecisionBrain {
        return this._decision;
    }

    public get config(): INavigatorBrainOptions {
        return this._config;
    }

    public get goal(): INavigatorGoal | null {
        return this._goal;
    }

    public get lastPerceptFeatures(): number[] | null {
        return this._lastPerceptFeatures;
    }

    /**
     * Full cascaded inference: raw sensor tensor → navigation command.
     *
     * Pipeline:
     *   1. Extract percept input (lidar + IMU) → flatten → MLP-Percept
     *   2. Extract decide input (percept features + pose + slip + goal) → flatten → MLP-Decide
     *   3. Map MLP-Decide raw output to `INavigationCommand`
     *
     * @param input  Full structured sensor tensor.
     * @returns      Motor-ready navigation command.
     */
    public evaluateCommand(input: INavigatorInputTensor): INavigationCommand {
        // --- Stage 1: Perception ---
        const perceptInput = NavigatorBrain.flattenPerceptInput(input);
        const features = this._percept.evaluate(perceptInput);
        this._lastPerceptFeatures = features;

        // --- Stage 2: Decision ---
        const decideInput = NavigatorBrain.flattenDecideInput(features, input);
        const raw = this._decision.evaluate(decideInput);

        // --- Stage 3: Output mapping ---
        const steering = raw[0]; // [0,1] — 0.5 = straight
        const throttle = raw[1]; // [0,1]
        const brake = raw[2]; // [0,1]
        const risk = raw[3]; // [0,1]

        return {
            steeringAngle: (steering - 0.5) * 2 * MAX_STEER_RAD,
            throttle,
            brake,
            risk,
            escalate: risk >= this._config.riskEscalationThreshold,
        };
    }

    public async loadPerceptWeights(uri: string): Promise<void> {
        const loader = this._config.weightLoader;
        if (!loader) {
            throw new Error("No IWeightLoader configured — cannot load percept weights from: " + uri);
        }
        await this._percept.loadWeights(uri, loader);
    }

    public async loadDecisionWeights(uri: string): Promise<void> {
        const loader = this._config.weightLoader;
        if (!loader) {
            throw new Error("No IWeightLoader configured — cannot load decision weights from: " + uri);
        }
        await this._decision.loadWeights(uri, loader);
    }

    public setGoal(goal: INavigatorGoal): void {
        this._goal = goal;
    }

    /**
     * Apply random perturbations to both sub-brains.
     * This is the sole "genetic operator" — no crossover, just mutation.
     *
     * @param weightScale  Max perturbation per weight. Default: 0.1.
     * @param biasScale    Max perturbation per bias. Default: 0.05.
     */
    public mutate(weightScale = 0.1, biasScale = 0.05): void {
        NavigatorBrain._mutateGraph(this._percept.graph, weightScale, biasScale);
        NavigatorBrain._mutateGraph(this._decision.graph, weightScale, biasScale);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Static helpers — tensor flattening
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Flatten perception MLP input.
     *
     * Layout (42 floats):
     *   [0..35]  lidar sectors (36)
     *   [36..41] IMU snapshot (6)
     */
    static flattenPerceptInput(input: INavigatorInputTensor): number[] {
        const flat = new Array<number>(PERCEPT_INPUT_COUNT);
        let offset = 0;

        // LiDAR sectors (36)
        for (let i = 0; i < NAVIGATOR_LIDAR_SECTORS; i++) {
            flat[offset++] = input.lidarSectors[i] ?? 0;
        }

        // IMU snapshot (6)
        for (let i = 0; i < 6; i++) {
            flat[offset++] = input.imu[i];
        }

        return flat;
    }

    /**
     * Flatten decision MLP input.
     *
     * Layout (21 floats):
     *   [0..7]   percept features (8)
     *   [8..13]  pose & velocity (6)
     *   [14..17] wheel slip (4, zero-padded)
     *   [18..20] goal vector (3)
     */
    static flattenDecideInput(features: number[], input: INavigatorInputTensor): number[] {
        const flat = new Array<number>(DECIDE_INPUT_COUNT);
        let offset = 0;

        // Percept features (8)
        for (let i = 0; i < PERCEPT_OUTPUT_COUNT; i++) {
            flat[offset++] = features[i] ?? 0;
        }

        // Pose & velocity (6)
        for (let i = 0; i < 6; i++) {
            flat[offset++] = input.pose[i];
        }

        // Wheel slip (4, zero-padded)
        for (let i = 0; i < 4; i++) {
            flat[offset++] = input.wheelSlip[i] ?? 0;
        }

        // Goal vector (3)
        for (let i = 0; i < 3; i++) {
            flat[offset++] = input.goal[i];
        }

        return flat;
    }

    /**
     * Apply mutation to a single graph's weights and biases.
     */
    private static _mutateGraph(graph: IMlpGraph, weightScale: number, biasScale: number): void {
        for (const syn of graph.links) {
            syn.weight += (Math.random() * 2 - 1) * weightScale;
        }
        for (const node of graph.nodes) {
            node.bias += (Math.random() * 2 - 1) * biasScale;
        }
    }
}
