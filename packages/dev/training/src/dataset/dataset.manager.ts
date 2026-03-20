// ═══════════════════════════════════════════════════════════════════════════
// Dataset manager — generate, split, shuffle, serialize
//
// Orchestrates the full pipeline from scenarios → training samples:
// 1. Generate scenarios (via IScenarioProvider)
// 2. Simulate sensors (raycaster + IMU)
// 3. Compute labels (percept labeler)
// 4. Split into train/validation/test
//
// Sensor simulation is pluggable via ISensorSimulator:
// - MathSensorSimulator (CPU, default) — fast for simple primitive scenes
// - BabylonSensorSimulator (GPU) — reads depth buffer, handles complex meshes
// ═══════════════════════════════════════════════════════════════════════════

import { IScenarioProvider, ILidarSimConfig, ISensorSimulator } from "@dev/training/scenario/scenario.interfaces";
import { MathSensorSimulator, DEFAULT_LIDAR_CONFIG } from "@dev/training/scenario/scenario.raycaster";
import { computePerceptLabels, IPerceptLabelerConfig, DEFAULT_LABELER_CONFIG } from "@dev/training/labels/labels.percept-labeler";
import {
    IDatasetSplitConfig,
    IPerceptTrainingSample,
    ISerializedDataset,
    ITrainingDataset,
    IDatasetSplit,
} from "./dataset.interfaces";

// ─── Seeded PRNG (xorshift32 for reproducible shuffling) ─────────────────────

function xorshift32(seed: number): () => number {
    let state = seed | 0 || 1; // ensure non-zero
    return (): number => {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return (state >>> 0) / 4294967296; // [0, 1)
    };
}

/** Fisher-Yates shuffle with seeded PRNG. */
function shuffleArray<T>(arr: T[], rng: () => number): void {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
}

// ─── Default split config ────────────────────────────────────────────────────

const DEFAULT_SPLIT: IDatasetSplitConfig = {
    trainRatio: 0.7,
    validationRatio: 0.15,
    testRatio: 0.15,
};

// ═══════════════════════════════════════════════════════════════════════════
// Dataset manager
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates and manages training datasets for the PerceptCortex.
 *
 * Sensor simulation is pluggable: defaults to `MathSensorSimulator` (CPU),
 * but can be replaced with a GPU-accelerated implementation for complex scenes.
 *
 * Usage:
 * ```typescript
 * // CPU (default — simple primitive scenes):
 * const manager = new DatasetManager(generator);
 *
 * // GPU (complex meshes, terrain — Babylon adapter):
 * const gpuSim = new BabylonSensorSimulator(engine, scene, camera);
 * const manager = new DatasetManager(generator, gpuSim);
 *
 * // Generate 10,000 labeled samples
 * const dataset = manager.generatePerceptDataset(10000);
 * ```
 */
export class DatasetManager {
    private readonly _provider: IScenarioProvider;
    private readonly _simulator: ISensorSimulator;
    private readonly _lidarConfig: ILidarSimConfig;
    private readonly _labelerConfig: IPerceptLabelerConfig;
    private readonly _imuNoise: number;

    constructor(
        provider: IScenarioProvider,
        simulator: ISensorSimulator = new MathSensorSimulator(),
        lidarConfig: ILidarSimConfig = DEFAULT_LIDAR_CONFIG,
        labelerConfig: IPerceptLabelerConfig = DEFAULT_LABELER_CONFIG,
        imuNoise: number = 0.02
    ) {
        this._provider = provider;
        this._simulator = simulator;
        this._lidarConfig = lidarConfig;
        this._labelerConfig = labelerConfig;
        this._imuNoise = imuNoise;
    }

    /**
     * Generate a complete PerceptCortex training dataset.
     *
     * For each scenario:
     * 1. Simulate LiDAR → 36 depth sectors
     * 2. Simulate IMU → 6 readings
     * 3. Compute ground truth labels → 8 features
     * 4. Create training sample (input = 42, label = 8)
     *
     * @param count       Number of samples to generate.
     * @param splitConfig Split ratios (default: 70/15/15).
     * @returns           Complete dataset with train/validation/test splits.
     */
    public generatePerceptDataset(
        count: number,
        splitConfig: IDatasetSplitConfig = DEFAULT_SPLIT
    ): ITrainingDataset<IPerceptTrainingSample> {
        const samples: IPerceptTrainingSample[] = [];

        for (let i = 0; i < count; i++) {
            const scenario = this._provider.generate();

            // Simulate sensors (delegates to ISensorSimulator — CPU or GPU)
            const depths = this._simulator.simulateLidar(scenario, scenario.pose, this._lidarConfig);
            const imu = this._simulator.simulateIMU(scenario.motion, this._imuNoise);

            // Compute ground truth
            const label = computePerceptLabels(depths, imu, this._labelerConfig);

            // Flatten input: [lidarSectors..., imu...]
            const input = [...depths, ...imu];

            samples.push({
                scenarioId: scenario.id,
                input,
                label,
                tags: scenario.tags,
            });
        }

        return this._splitDataset(samples, splitConfig, "random");
    }

    /**
     * Split samples into train/validation/test sets.
     */
    private _splitDataset(
        samples: IPerceptTrainingSample[],
        config: IDatasetSplitConfig,
        generatorType: string
    ): ITrainingDataset<IPerceptTrainingSample> {
        const rng = xorshift32(config.seed ?? Date.now());
        shuffleArray(samples, rng);

        const total = samples.length;
        const trainEnd = Math.floor(total * config.trainRatio);
        const valEnd = trainEnd + Math.floor(total * config.validationRatio);

        const trainSamples = samples.slice(0, trainEnd);
        const valSamples = samples.slice(trainEnd, valEnd);
        const testSamples = samples.slice(valEnd);

        const makeSplit = (name: string, s: IPerceptTrainingSample[]): IDatasetSplit<IPerceptTrainingSample> => ({
            name,
            samples: s,
            get length() {
                return this.samples.length;
            },
        });

        return {
            train: makeSplit("train", trainSamples),
            validation: makeSplit("validation", valSamples),
            test: makeSplit("test", testSamples),
            get totalSize() {
                return this.train.length + this.validation.length + this.test.length;
            },
            metadata: {
                createdAt: new Date().toISOString(),
                scenarioCount: total,
                generatorType,
            },
        };
    }

    /**
     * Serialize a dataset to JSON-compatible format for persistence.
     */
    public serialize(dataset: ITrainingDataset<IPerceptTrainingSample>): ISerializedDataset {
        const allSamples: ISerializedDataset["samples"] = [];

        const addSplit = (split: IDatasetSplit<IPerceptTrainingSample>, splitName: "train" | "validation" | "test"): void => {
            for (const s of split.samples) {
                allSamples.push({
                    input: s.input,
                    label: s.label,
                    scenarioId: s.scenarioId,
                    tags: s.tags,
                    split: splitName,
                });
            }
        };

        addSplit(dataset.train, "train");
        addSplit(dataset.validation, "validation");
        addSplit(dataset.test, "test");

        return {
            version: "1.0.0",
            metadata: dataset.metadata,
            samples: allSamples,
        };
    }

    /**
     * Deserialize a dataset from JSON.
     */
    public deserialize(data: ISerializedDataset): ITrainingDataset<IPerceptTrainingSample> {
        const train: IPerceptTrainingSample[] = [];
        const validation: IPerceptTrainingSample[] = [];
        const test: IPerceptTrainingSample[] = [];

        for (const s of data.samples) {
            const sample: IPerceptTrainingSample = {
                scenarioId: s.scenarioId,
                input: s.input,
                label: s.label ?? [],
                tags: s.tags,
            };

            switch (s.split) {
                case "train":
                    train.push(sample);
                    break;
                case "validation":
                    validation.push(sample);
                    break;
                case "test":
                    test.push(sample);
                    break;
            }
        }

        const makeSplit = (name: string, samples: IPerceptTrainingSample[]): IDatasetSplit<IPerceptTrainingSample> => ({
            name,
            samples,
            get length() {
                return this.samples.length;
            },
        });

        return {
            train: makeSplit("train", train),
            validation: makeSplit("validation", validation),
            test: makeSplit("test", test),
            get totalSize() {
                return this.train.length + this.validation.length + this.test.length;
            },
            metadata: data.metadata,
        };
    }
}
