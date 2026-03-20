// ═══════════════════════════════════════════════════════════════════════════
// Training loop interfaces
//
// Framework-agnostic configuration and result types for both
// supervised (Phase 1) and evolutionary (Phase 2) training.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for supervised PerceptCortex training (Phase 1).
 */
export interface ISupervisedTrainingConfig {
    /**
     * Number of training epochs.
     * One epoch = one pass through the entire training set.
     * Default: 100.
     */
    epochs: number;

    /**
     * Learning rate for gradient approximation.
     * Used as the perturbation scale in the numerical gradient.
     * Default: 0.01.
     */
    learningRate: number;

    /**
     * Mini-batch size for stochastic training.
     * Smaller = noisier gradient estimate but faster per step.
     * Default: 32.
     */
    batchSize: number;

    /**
     * Validation frequency: evaluate on validation set every N epochs.
     * Default: 5.
     */
    validationInterval: number;

    /**
     * Early stopping patience: stop if validation loss doesn't improve
     * for this many consecutive validation checks.
     * 0 = no early stopping.
     * Default: 10.
     */
    earlyStoppingPatience: number;

    /**
     * Perturbation epsilon for numerical gradient estimation.
     * Each weight is perturbed by ±epsilon to estimate ∂loss/∂w.
     * Default: 0.001.
     */
    epsilon: number;

    /**
     * Callback invoked at the end of each epoch.
     * Use for logging, progress reporting, or MCP status updates.
     */
    onEpochEnd?: (result: IEpochResult) => void;
}

/**
 * Result of a single training epoch.
 */
export interface IEpochResult {
    /** Epoch number (0-indexed). */
    epoch: number;

    /** Average MSE loss on the training set for this epoch. */
    trainLoss: number;

    /** Average MSE loss on the validation set (only set at validation intervals). */
    validationLoss?: number;

    /** Per-feature MSE on the validation set (8 values). */
    perFeatureLoss?: number[];

    /** Duration of this epoch in milliseconds. */
    durationMs: number;

    /** Best validation loss seen so far. */
    bestValidationLoss: number;

    /** Whether early stopping was triggered. */
    earlyStopped: boolean;
}

/**
 * Final result of a supervised training run.
 */
export interface ISupervisedTrainingResult {
    /** All epoch results. */
    epochs: IEpochResult[];

    /** Final training loss. */
    finalTrainLoss: number;

    /** Final validation loss. */
    finalValidationLoss: number;

    /** Per-feature validation MSE (8 values). */
    perFeatureValidationLoss: number[];

    /** Best validation loss achieved. */
    bestValidationLoss: number;

    /** Epoch at which best validation was achieved. */
    bestEpoch: number;

    /** Total training time in milliseconds. */
    totalDurationMs: number;

    /** Whether training was stopped early. */
    earlyStopped: boolean;

    /** Extracted best weights (to load into the cortex). */
    bestWeights: number[];

    /** Extracted best biases. */
    bestBiases: number[];
}

// ─── Evolutionary training (Phase 2) ────────────────────────────────────────

/**
 * Configuration for evolutionary training of the full cascade (Phase 2).
 */
export interface IEvolutionaryTrainingConfig {
    /**
     * Population size: number of brains evaluated per generation.
     * Default: 50.
     */
    populationSize: number;

    /**
     * Number of generations to evolve.
     * Default: 200.
     */
    generations: number;

    /**
     * Fraction of top performers that survive to the next generation.
     * Default: 0.2 (top 20%).
     */
    eliteRatio: number;

    /**
     * Mutation scale for synapse weights.
     * Each weight gets: w += uniform(−1, +1) × mutationWeightScale.
     * Default: 0.1.
     */
    mutationWeightScale: number;

    /**
     * Mutation scale for neuron biases.
     * Each bias gets: b += uniform(−1, +1) × mutationBiasScale.
     * Default: 0.05.
     */
    mutationBiasScale: number;

    /**
     * Number of scenarios per fitness evaluation.
     * Each brain is tested on this many random scenarios per generation.
     * Default: 20.
     */
    scenariosPerEval: number;

    /**
     * Maximum simulation steps per scenario evaluation.
     * Prevents infinite loops in dead-end scenarios.
     * Default: 500.
     */
    maxStepsPerScenario: number;

    /**
     * Whether to freeze the PerceptCortex during evolution.
     * If true, only the DecisionCortex mutates.
     * Useful when the PerceptCortex was pre-trained in Phase 1.
     * Default: true.
     */
    freezePercept: boolean;

    /**
     * Callback invoked at the end of each generation.
     */
    onGenerationEnd?: (result: IGenerationResult) => void;
}

/**
 * Fitness function: evaluates how well a brain navigated a scenario.
 */
export interface IFitnessFunction {
    /**
     * Compute fitness score for a single scenario evaluation.
     *
     * Higher = better. Typical components:
     * - Distance to goal (closer = higher)
     * - Collision penalty (hit obstacle = severe deduction)
     * - Time efficiency (faster = higher)
     * - Smoothness (less jitter = higher)
     *
     * @param distToGoal      Final distance to goal (meters).
     * @param collisionCount  Number of times the rover hit an obstacle.
     * @param stepsUsed       Simulation steps taken.
     * @param maxSteps        Maximum allowed steps.
     * @returns               Fitness score (higher = better).
     */
    evaluate(
        distToGoal: number,
        collisionCount: number,
        stepsUsed: number,
        maxSteps: number
    ): number;
}

/**
 * Result of a single generation in evolutionary training.
 */
export interface IGenerationResult {
    /** Generation number (0-indexed). */
    generation: number;

    /** Best fitness in this generation. */
    bestFitness: number;

    /** Average fitness across the population. */
    avgFitness: number;

    /** Worst fitness. */
    worstFitness: number;

    /** Duration of this generation in milliseconds. */
    durationMs: number;
}

/**
 * Final result of an evolutionary training run.
 */
export interface IEvolutionaryTrainingResult {
    /** All generation results. */
    generations: IGenerationResult[];

    /** Best fitness achieved across all generations. */
    bestFitness: number;

    /** Generation at which best fitness was achieved. */
    bestGeneration: number;

    /** Total training time in milliseconds. */
    totalDurationMs: number;

    /** Best weights for the PerceptCortex (empty if frozen). */
    bestPerceptWeights: number[];
    bestPerceptBiases: number[];

    /** Best weights for the DecisionCortex. */
    bestDecisionWeights: number[];
    bestDecisionBiases: number[];
}
