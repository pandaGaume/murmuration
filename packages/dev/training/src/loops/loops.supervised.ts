// ═══════════════════════════════════════════════════════════════════════════
// Supervised training loop — Phase 1: PerceptCortex pre-training
//
// Uses @spiky-panda/core's built-in MLPTrainingRuntime for real
// backpropagation with configurable optimizers (SGD, Adam, NAG).
//
// The training loop:
// 1. Forward pass: run MLP on input
// 2. Backpropagate: compute gradients via chain rule
// 3. Optimizer step: update weights (Adam by default)
// 4. Repeat for all samples in mini-batches
// 5. Validate periodically, early stop if plateau
// ═══════════════════════════════════════════════════════════════════════════

import {
    IMlpGraph,
    IOptimizer,
    ILossFunction,
    LossFunctions,
    MLPInferenceRuntime,
    MLPTrainingRuntime,
    Optimizers,
} from "@spiky-panda/core";

import { IPerceptTrainingSample, IDatasetSplit } from "@dev/training/dataset/dataset.interfaces";
import {
    ISupervisedTrainingConfig,
    ISupervisedTrainingResult,
    IEpochResult,
} from "./loops.interfaces";

// ─── Default config ──────────────────────────────────────────────────────────

const DEFAULT_SUPERVISED_CONFIG: ISupervisedTrainingConfig = {
    epochs: 100,
    learningRate: 0.01,
    batchSize: 32,
    validationInterval: 5,
    earlyStoppingPatience: 10,
    epsilon: 0.001, // unused now — kept for interface compatibility
};

// ─── Weight snapshot helpers ─────────────────────────────────────────────────

function extractWeights(graph: IMlpGraph): number[] {
    return graph.links.map((link) => link.weight);
}

function extractBiases(graph: IMlpGraph): number[] {
    return graph.nodes.map((node) => node.bias);
}

function applyWeights(graph: IMlpGraph, weights: number[]): void {
    const links = graph.links;
    for (let i = 0; i < links.length && i < weights.length; i++) {
        links[i].weight = weights[i];
    }
}

function applyBiases(graph: IMlpGraph, biases: number[]): void {
    const nodes = graph.nodes;
    for (let i = 0; i < nodes.length && i < biases.length; i++) {
        nodes[i].bias = biases[i];
    }
}

// ─── Validation loss computation ─────────────────────────────────────────────

/**
 * Compute average MSE across a validation set using inference-only runtime.
 */
function validationMSE(
    runtime: MLPInferenceRuntime,
    samples: IPerceptTrainingSample[]
): number {
    let totalLoss = 0;
    const featureCount = samples[0]?.label.length ?? 8;

    for (const sample of samples) {
        const output = runtime.run(sample.input);
        for (let i = 0; i < featureCount; i++) {
            const diff = output[i] - sample.label[i];
            totalLoss += diff * diff;
        }
    }

    return totalLoss / (samples.length * featureCount);
}

/**
 * Per-feature MSE (for diagnostics: which output is hardest to learn?).
 */
function perFeatureMSE(
    runtime: MLPInferenceRuntime,
    samples: IPerceptTrainingSample[],
    featureCount: number
): number[] {
    const sums = new Array<number>(featureCount).fill(0);

    for (const sample of samples) {
        const output = runtime.run(sample.input);
        for (let i = 0; i < featureCount; i++) {
            const diff = output[i] - sample.label[i];
            sums[i] += diff * diff;
        }
    }

    return sums.map((s) => s / samples.length);
}

// ─── Shuffle ─────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Supervised training using @spiky-panda/core backpropagation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Train a PerceptCortex MLP graph using real backpropagation.
 *
 * Leverages `@spiky-panda/core`'s `MLPTrainingRuntime` which provides:
 * - Proper gradient computation via the chain rule
 * - Pluggable optimizers: SGD, MomentumSGD, NAG, Adam
 * - MSE and CrossEntropy loss functions
 *
 * **Default optimizer**: Adam (adaptive learning rate, best for this
 * kind of regression task with mixed-scale outputs).
 *
 * @param graph       The MLP graph to train (modified in place).
 * @param trainSet    Training data split.
 * @param valSet      Validation data split.
 * @param config      Training hyperparameters.
 * @param optimizer   Optimizer from `Optimizers.*` (default: Adam).
 * @param lossFn      Loss function from `LossFunctions.*` (default: MSE).
 * @returns           Training results with best weights.
 */
export function trainSupervisedPercept(
    graph: IMlpGraph,
    trainSet: IDatasetSplit<IPerceptTrainingSample>,
    valSet: IDatasetSplit<IPerceptTrainingSample>,
    config: Partial<ISupervisedTrainingConfig> = {},
    optimizer: IOptimizer = Optimizers.Adam(),
    lossFn: ILossFunction = LossFunctions.MSE
): ISupervisedTrainingResult {
    const cfg = { ...DEFAULT_SUPERVISED_CONFIG, ...config };
    const inferenceRuntime = new MLPInferenceRuntime(graph);
    const trainingRuntime = new MLPTrainingRuntime(
        graph,
        inferenceRuntime,
        lossFn,
        cfg.learningRate,
        optimizer
    );

    const epochResults: IEpochResult[] = [];
    let bestValLoss = Infinity;
    let bestEpoch = 0;
    let bestWeights = extractWeights(graph);
    let bestBiases = extractBiases(graph);
    let patienceCounter = 0;
    let earlyStopped = false;

    const totalStart = performance.now();

    for (let epoch = 0; epoch < cfg.epochs; epoch++) {
        const epochStart = performance.now();

        // Shuffle training data
        const shuffled = [...trainSet.samples];
        shuffle(shuffled);

        // ── Train on all samples ──
        let epochLoss = 0;
        let sampleCount = 0;

        for (const sample of shuffled) {
            // trainStep does: forward → backprop → optimizer.apply
            // Returns the loss for this single sample.
            const loss = trainingRuntime.trainStep(sample.input, sample.label);
            epochLoss += loss;
            sampleCount++;
        }

        epochLoss /= sampleCount;

        // ── Validation ──
        let valLoss: number | undefined;
        let featureLoss: number[] | undefined;

        if ((epoch + 1) % cfg.validationInterval === 0 || epoch === cfg.epochs - 1) {
            valLoss = validationMSE(inferenceRuntime, valSet.samples);
            featureLoss = perFeatureMSE(inferenceRuntime, valSet.samples, 8);

            if (valLoss < bestValLoss) {
                bestValLoss = valLoss;
                bestEpoch = epoch;
                bestWeights = extractWeights(graph);
                bestBiases = extractBiases(graph);
                patienceCounter = 0;
            } else {
                patienceCounter++;
            }

            if (cfg.earlyStoppingPatience > 0 && patienceCounter >= cfg.earlyStoppingPatience) {
                earlyStopped = true;
            }
        }

        const epochResult: IEpochResult = {
            epoch,
            trainLoss: epochLoss,
            validationLoss: valLoss,
            perFeatureLoss: featureLoss,
            durationMs: performance.now() - epochStart,
            bestValidationLoss: bestValLoss,
            earlyStopped,
        };

        epochResults.push(epochResult);
        cfg.onEpochEnd?.(epochResult);

        if (earlyStopped) break;
    }

    // Restore best weights (from the epoch with lowest validation loss)
    applyWeights(graph, bestWeights);
    applyBiases(graph, bestBiases);

    // Clean up training context to free memory
    trainingRuntime.deleteContext();

    const lastResult = epochResults[epochResults.length - 1];

    return {
        epochs: epochResults,
        finalTrainLoss: lastResult.trainLoss,
        finalValidationLoss: lastResult.validationLoss ?? bestValLoss,
        perFeatureValidationLoss: lastResult.perFeatureLoss ?? [],
        bestValidationLoss: bestValLoss,
        bestEpoch,
        totalDurationMs: performance.now() - totalStart,
        earlyStopped,
        bestWeights,
        bestBiases,
    };
}
