// ═══════════════════════════════════════════════════════════════════════════
// Training loop for the MatchingCortex — learned stereo matching
//
// Uses @spiky-panda/core's MLPTrainingRuntime for backpropagation.
//
// Training data:
// - Input: left patch (81) + right patch (81) + position (2) = 164 floats
// - Label: [disparity_normalized, confidence] = 2 floats
//
// Ground truth comes from the MathStereoSimulator:
// - Ideal disparity from raycasting (no noise)
// - Confidence from depth range (far = low, near = high)
// ═══════════════════════════════════════════════════════════════════════════

import {
    IMlpGraph,
    ILossFunction,
    IOptimizer,
    LossFunctions,
    MLPInferenceRuntime,
    MLPTrainingRuntime,
    Optimizers,
} from "@spiky-panda/core";

import { IScenarioProvider, ILidarSimConfig } from "@dev/training/scenario/scenario.interfaces";
import { simulateLidar } from "@dev/training/scenario/scenario.raycaster";
import { MATCHING_PATCH_SIZE, MATCHING_INPUT_SIZE } from "@dev/core/compute";
import {
    ISupervisedTrainingConfig,
    ISupervisedTrainingResult,
    IEpochResult,
} from "./loops.interfaces";

// ─── Training sample for matching ────────────────────────────────────────────

export interface IMatchingTrainingSample {
    /** MLP input: left patch + right patch + position. Length = 164. */
    input: number[];

    /** Ground truth: [disparity_normalized, confidence]. Length = 2. */
    label: number[];
}

// ─── Ground truth generation ─────────────────────────────────────────────────

/**
 * Generate matching training samples from a scenario.
 *
 * For each grid cell:
 * 1. Raycast from left camera position → ideal depth
 * 2. Raycast from right camera position → ideal depth (shifted by baseline)
 * 3. Compute ideal disparity = baseline × focalPx / depth
 * 4. Build left/right patches from the depth maps
 * 5. Confidence from depth range
 *
 * @param provider       Scenario generator.
 * @param count          Number of samples to generate.
 * @param gridCols       Grid columns (default 36).
 * @param baseline       Stereo baseline in scene units (default 0.42).
 * @param maxDisparity   Max disparity for normalization (default 128).
 * @param focalLengthPx  Focal length in pixels (default 500).
 * @param imageWidth     Simulated image width (default 256).
 * @param maxRange       Max depth range (default 100).
 */
export function generateMatchingSamples(
    provider: IScenarioProvider,
    count: number,
    gridCols: number = 36,
    baseline: number = 0.42,
    maxDisparity: number = 128,
    focalLengthPx: number = 500,
    imageWidth: number = 256,
    maxRange: number = 100
): IMatchingTrainingSample[] {
    const samples: IMatchingTrainingSample[] = [];
    const halfPatch = Math.floor(MATCHING_PATCH_SIZE / 2);

    const lidarConfig: ILidarSimConfig = {
        sectorCount: imageWidth,
        horizontalFov: Math.PI * 0.75,
        maxRange,
        raysPerSector: 1,
    };

    while (samples.length < count) {
        const scenario = provider.generate();

        // Compute perpendicular direction for stereo offset
        const perpX = -Math.cos(scenario.pose.heading);
        const perpZ = Math.sin(scenario.pose.heading);
        const halfBase = baseline / 2;

        // Left camera depths (full resolution)
        const leftPose = {
            ...scenario.pose,
            position: {
                x: scenario.pose.position.x + perpX * halfBase,
                y: scenario.pose.position.y,
                z: scenario.pose.position.z + perpZ * halfBase,
            },
        };
        const leftDepths = simulateLidar(scenario, leftPose, lidarConfig);

        // Right camera depths
        const rightPose = {
            ...scenario.pose,
            position: {
                x: scenario.pose.position.x - perpX * halfBase,
                y: scenario.pose.position.y,
                z: scenario.pose.position.z - perpZ * halfBase,
            },
        };
        const rightDepths = simulateLidar(scenario, rightPose, lidarConfig);

        // Generate samples for each grid cell
        const cellWidth = imageWidth / gridCols;

        for (let col = 0; col < gridCols; col++) {
            const cx = Math.floor((col + 0.5) * cellWidth);

            // Build patches (using 1D depth arrays as pseudo-images)
            const input = new Array<number>(MATCHING_INPUT_SIZE);
            let idx = 0;

            // Left patch (9 samples centered at cx, repeated vertically)
            for (let py = 0; py < MATCHING_PATCH_SIZE; py++) {
                for (let px = -halfPatch; px <= halfPatch; px++) {
                    const ix = Math.max(0, Math.min(cx + px, imageWidth - 1));
                    input[idx++] = leftDepths[ix] / maxRange; // normalize
                }
            }

            // Right patch
            for (let py = 0; py < MATCHING_PATCH_SIZE; py++) {
                for (let px = -halfPatch; px <= halfPatch; px++) {
                    const ix = Math.max(0, Math.min(cx + px, imageWidth - 1));
                    input[idx++] = rightDepths[ix] / maxRange;
                }
            }

            // Normalized position
            input[idx++] = 0.5; // row (single row)
            input[idx++] = col / Math.max(gridCols - 1, 1);

            // Ground truth
            const depth = leftDepths[cx];
            let disparityNorm = 0;
            let confidence = 0;

            if (depth > 0 && depth < maxRange) {
                const disparity = baseline * focalLengthPx / depth;
                disparityNorm = Math.min(disparity / maxDisparity, 1.0);
                // Confidence: high for near objects, low for far
                confidence = Math.max(0, 1.0 - depth / maxRange);
            }

            samples.push({
                input,
                label: [disparityNorm, confidence],
            });

            if (samples.length >= count) break;
        }
    }

    return samples.slice(0, count);
}

// ─── Training loop ───────────────────────────────────────────────────────────

/**
 * Train a MatchingCortex MLP using supervised backpropagation.
 *
 * Same pattern as `trainSupervisedPercept` but for the matching task:
 * - Input: 164 (patches + position)
 * - Output: 2 (disparity + confidence)
 * - Loss: MSE
 * - Optimizer: Adam (default)
 */
export function trainMatchingCortex(
    graph: IMlpGraph,
    samples: IMatchingTrainingSample[],
    validationSamples: IMatchingTrainingSample[],
    config: Partial<ISupervisedTrainingConfig> = {},
    optimizer: IOptimizer = Optimizers.Adam(),
    lossFn: ILossFunction = LossFunctions.MSE
): ISupervisedTrainingResult {
    const cfg: ISupervisedTrainingConfig = {
        epochs: 100,
        learningRate: 0.005,
        batchSize: 64,
        validationInterval: 5,
        earlyStoppingPatience: 10,
        epsilon: 0.001,
        ...config,
    };

    const inferenceRuntime = new MLPInferenceRuntime(graph);
    const trainingRuntime = new MLPTrainingRuntime(graph, inferenceRuntime, lossFn, cfg.learningRate, optimizer);

    const epochResults: IEpochResult[] = [];
    let bestValLoss = Infinity;
    let bestEpoch = 0;
    let bestWeights = graph.links.map((l) => l.weight);
    let bestBiases = graph.nodes.map((n) => n.bias);
    let patienceCounter = 0;
    let earlyStopped = false;

    const totalStart = performance.now();

    for (let epoch = 0; epoch < cfg.epochs; epoch++) {
        const epochStart = performance.now();

        // Shuffle
        const shuffled = [...samples];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        // Train
        let epochLoss = 0;
        for (const sample of shuffled) {
            epochLoss += trainingRuntime.trainStep(sample.input, sample.label);
        }
        epochLoss /= shuffled.length;

        // Validation
        let valLoss: number | undefined;
        let featureLoss: number[] | undefined;

        if ((epoch + 1) % cfg.validationInterval === 0 || epoch === cfg.epochs - 1) {
            let vLoss = 0;
            const perFeature = [0, 0];
            for (const s of validationSamples) {
                const out = inferenceRuntime.run(s.input);
                for (let i = 0; i < 2; i++) {
                    const d = out[i] - s.label[i];
                    perFeature[i] += d * d;
                    vLoss += d * d;
                }
            }
            valLoss = vLoss / (validationSamples.length * 2);
            featureLoss = perFeature.map((s) => s / validationSamples.length);

            if (valLoss < bestValLoss) {
                bestValLoss = valLoss;
                bestEpoch = epoch;
                bestWeights = graph.links.map((l) => l.weight);
                bestBiases = graph.nodes.map((n) => n.bias);
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

    // Restore best weights
    const links = graph.links;
    for (let i = 0; i < links.length && i < bestWeights.length; i++) {
        links[i].weight = bestWeights[i];
    }
    const nodes = graph.nodes;
    for (let i = 0; i < nodes.length && i < bestBiases.length; i++) {
        nodes[i].bias = bestBiases[i];
    }

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
