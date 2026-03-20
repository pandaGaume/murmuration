// ═══════════════════════════════════════════════════════════════════════════
// Dataset interfaces — storage, split, and iteration for training data
//
// A dataset is a collection of training samples. Each sample pairs
// an input (sensor readings) with a label (ground truth perception output).
//
// Datasets are framework-agnostic: they contain pure numbers, not
// Babylon vectors or GPU tensors. They can be serialized to JSON,
// stored on disk, or generated on-the-fly from scenarios.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single training sample for the PerceptCortex.
 *
 * Input = what the MLP receives (42 floats: 36 LiDAR + 6 IMU).
 * Label = what the MLP should output (8 floats: perception features).
 */
export interface IPerceptTrainingSample {
    /** Scenario ID this sample was generated from (for traceability). */
    scenarioId: string;

    /**
     * Flattened input vector (length = PERCEPT_INPUT_COUNT = 42).
     * Layout: [lidarSectors[0..35], imu[0..5]]
     */
    input: number[];

    /**
     * Ground truth label vector (length = PERCEPT_OUTPUT_COUNT = 8).
     * Layout: matches PerceptFeatureIndex order.
     */
    label: number[];

    /** Optional tags inherited from the scenario. */
    tags?: string[];
}

/**
 * A single training sample for the full cascade (percept + decision).
 *
 * Used for Phase 2 end-to-end evolutionary training where fitness
 * is measured by navigation success, not label accuracy.
 */
export interface INavigationTrainingSample {
    /** Scenario ID. */
    scenarioId: string;

    /**
     * Full input tensor (length = NAVIGATOR_INPUT_COUNT = 55).
     * Layout: [lidarSectors[0..35], imu[0..5], pose[0..5], slip[0..3], goal[0..2]]
     */
    input: number[];

    /**
     * Goal position for fitness evaluation.
     * The evolutionary loop measures "how well did the rover reach this point?"
     */
    goal: [number, number, number];

    /** Optional tags. */
    tags?: string[];
}

/**
 * A dataset split: train, validation, or test.
 */
export interface IDatasetSplit<T> {
    /** Split name for identification. */
    name: string;

    /** Samples in this split. */
    samples: T[];

    /** Number of samples. */
    readonly length: number;
}

/**
 * A complete training dataset with train/validation/test splits.
 */
export interface ITrainingDataset<T> {
    /** Training split (used for weight updates). */
    train: IDatasetSplit<T>;

    /** Validation split (used for early stopping / hyperparameter tuning). */
    validation: IDatasetSplit<T>;

    /** Test split (held out, used only for final evaluation). */
    test: IDatasetSplit<T>;

    /** Total sample count across all splits. */
    readonly totalSize: number;

    /** Dataset metadata. */
    metadata: IDatasetMetadata;
}

/**
 * Dataset metadata for tracking provenance.
 */
export interface IDatasetMetadata {
    /** When the dataset was generated. */
    createdAt: string;

    /** Number of scenarios used to generate the dataset. */
    scenarioCount: number;

    /** Generator type (e.g., "random", "mcp", "mixed"). */
    generatorType: string;

    /** Constraints used during generation (if applicable). */
    constraints?: Record<string, unknown>;

    /** Any additional notes. */
    notes?: string;
}

/**
 * Configuration for dataset splitting.
 */
export interface IDatasetSplitConfig {
    /** Fraction of samples for training (default 0.7). */
    trainRatio: number;

    /** Fraction for validation (default 0.15). */
    validationRatio: number;

    /** Fraction for testing (default 0.15). */
    testRatio: number;

    /** Random seed for reproducible shuffling (default: current timestamp). */
    seed?: number;
}

/**
 * Serialization format for dataset persistence.
 */
export interface ISerializedDataset {
    /** Format version for backward compatibility. */
    version: string;

    /** Metadata. */
    metadata: IDatasetMetadata;

    /** All samples (split assignment stored per sample or reconstructed from ratios). */
    samples: Array<{
        input: number[];
        label?: number[];
        goal?: [number, number, number];
        scenarioId: string;
        tags?: string[];
        split: "train" | "validation" | "test";
    }>;
}
