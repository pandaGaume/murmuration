// ═══════════════════════════════════════════════════════════════════════════
// Evolutionary training loop — Phase 2: full cascade optimization
//
// Evolves the NavigatorBrain (PerceptCortex + DecisionCortex) using
// mutation-based genetic selection — the same approach as CreatureBrain
// in the bestioles project.
//
// Algorithm per generation:
// 1. Evaluate each brain on N random scenarios
// 2. Rank by fitness (goal distance + collision penalty + time efficiency)
// 3. Select top elites
// 4. Clone elites → fill population
// 5. Mutate all non-elite clones
// 6. Repeat
//
// The PerceptCortex can optionally be frozen (Phase 1 pre-trained).
// In that case only the DecisionCortex weights mutate.
// ═══════════════════════════════════════════════════════════════════════════

import { IMlpGraph } from "@spiky-panda/core";
import { IScenarioProvider } from "@dev/training/scenario/scenario.interfaces";
import { simulateLidar, simulateIMU, DEFAULT_LIDAR_CONFIG } from "@dev/training/scenario/scenario.raycaster";
import {
    IEvolutionaryTrainingConfig,
    IEvolutionaryTrainingResult,
    IFitnessFunction,
    IGenerationResult,
} from "./loops.interfaces";

// ─── Default config ──────────────────────────────────────────────────────────

const DEFAULT_EVOLUTIONARY_CONFIG: IEvolutionaryTrainingConfig = {
    populationSize: 50,
    generations: 200,
    eliteRatio: 0.2,
    mutationWeightScale: 0.1,
    mutationBiasScale: 0.05,
    scenariosPerEval: 20,
    maxStepsPerScenario: 500,
    freezePercept: true,
};

// ─── Default fitness function ────────────────────────────────────────────────

/**
 * Standard fitness function for navigation tasks.
 *
 * Components:
 * - Goal proximity bonus (closer = higher, exponential falloff)
 * - Collision penalty (severe, multiplicative)
 * - Time efficiency bonus (faster = slightly higher)
 */
export class StandardFitness implements IFitnessFunction {
    public evaluate(
        distToGoal: number,
        collisionCount: number,
        stepsUsed: number,
        maxSteps: number
    ): number {
        // Goal proximity: 100 when at goal, decays with distance
        const goalScore = 100 * Math.exp(-distToGoal / 10);

        // Collision penalty: each collision halves the score
        const collisionPenalty = Math.pow(0.5, collisionCount);

        // Time efficiency: small bonus for finishing faster
        const timeBonus = 1.0 + 0.2 * (1.0 - stepsUsed / maxSteps);

        return goalScore * collisionPenalty * timeBonus;
    }
}

// ─── Brain wrapper for population management ─────────────────────────────────

/**
 * Lightweight wrapper around the two MLP graphs for population cloning.
 */
interface IPopulationMember {
    perceptGraph: IMlpGraph;
    decisionGraph: IMlpGraph;
    fitness: number;
}

/**
 * Clone weights and biases from source to destination graph.
 */
function cloneGraphWeights(src: IMlpGraph, dst: IMlpGraph): void {
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
 * Apply random mutations to a graph's weights and biases.
 */
function mutateGraph(graph: IMlpGraph, weightScale: number, biasScale: number): void {
    for (const link of graph.links) {
        link.weight += (Math.random() * 2 - 1) * weightScale;
    }
    for (const node of graph.nodes) {
        node.bias += (Math.random() * 2 - 1) * biasScale;
    }
}

/**
 * Extract weights from a graph as a flat array.
 */
function extractWeights(graph: IMlpGraph): number[] {
    return graph.links.map((l) => l.weight);
}

/**
 * Extract biases from a graph as a flat array.
 */
function extractBiases(graph: IMlpGraph): number[] {
    return graph.nodes.map((n) => n.bias);
}

// ═══════════════════════════════════════════════════════════════════════════
// Evolutionary training
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evolve the NavigatorBrain's DecisionCortex (and optionally PerceptCortex)
 * using mutation-based genetic selection.
 *
 * @param createPerceptGraph   Factory function to create a fresh PerceptCortex graph.
 * @param createDecisionGraph  Factory function to create a fresh DecisionCortex graph.
 * @param scenarioProvider     Source of evaluation scenarios.
 * @param fitness              Fitness function for scoring.
 * @param config               Evolutionary hyperparameters.
 * @returns                    Training results with best weights.
 */
export function trainEvolutionary(
    createPerceptGraph: () => IMlpGraph,
    createDecisionGraph: () => IMlpGraph,
    scenarioProvider: IScenarioProvider,
    fitness: IFitnessFunction = new StandardFitness(),
    config: Partial<IEvolutionaryTrainingConfig> = {}
): IEvolutionaryTrainingResult {
    const cfg = { ...DEFAULT_EVOLUTIONARY_CONFIG, ...config };
    const generationResults: IGenerationResult[] = [];

    let bestOverallFitness = -Infinity;
    let bestGeneration = 0;
    let bestPerceptWeights: number[] = [];
    let bestPerceptBiases: number[] = [];
    let bestDecisionWeights: number[] = [];
    let bestDecisionBiases: number[] = [];

    // ── Initialize population ──
    const population: IPopulationMember[] = [];
    for (let i = 0; i < cfg.populationSize; i++) {
        population.push({
            perceptGraph: createPerceptGraph(),
            decisionGraph: createDecisionGraph(),
            fitness: 0,
        });
    }

    const eliteCount = Math.max(1, Math.floor(cfg.populationSize * cfg.eliteRatio));
    const totalStart = performance.now();

    // ── Generation loop ──
    for (let gen = 0; gen < cfg.generations; gen++) {
        const genStart = performance.now();

        // ── Evaluate each member ──
        for (const member of population) {
            let totalFitness = 0;

            for (let s = 0; s < cfg.scenariosPerEval; s++) {
                const scenario = scenarioProvider.generate();

                // Simple simulation: run the brain for maxSteps
                // Track distance to goal and collisions
                let posX = scenario.pose.position.x;
                let posZ = scenario.pose.position.z;
                let heading = scenario.pose.heading;
                let collisions = 0;

                const goalX = scenario.goal?.x ?? 0;
                const goalZ = scenario.goal?.z ?? 0;

                for (let step = 0; step < cfg.maxStepsPerScenario; step++) {
                    // Simulate sensors at current position
                    const currentPose = {
                        ...scenario.pose,
                        position: { x: posX, y: scenario.pose.position.y, z: posZ },
                        heading,
                    };
                    const depths = simulateLidar(
                        { ...scenario, pose: currentPose },
                        currentPose,
                        DEFAULT_LIDAR_CONFIG
                    );
                    const imu = simulateIMU(scenario.motion, 0.02);

                    // Run PerceptCortex
                    const perceptInput = [...depths, ...imu];
                    const { MLPInferenceRuntime } = require("@spiky-panda/core");
                    const perceptRuntime = new MLPInferenceRuntime(member.perceptGraph);
                    const features = perceptRuntime.run(perceptInput);

                    // Build DecisionCortex input
                    const dx = goalX - posX;
                    const dz = goalZ - posZ;
                    const dTheta = Math.atan2(dx, dz) - heading;
                    const decisionInput = [
                        ...features,             // 8 percept features
                        posX, 0, posZ, 0, 0, 0,  // pose (simplified)
                        0, 0, 0, 0,              // wheel slip (none)
                        dx, dz, dTheta,           // goal vector
                    ];

                    const decisionRuntime = new MLPInferenceRuntime(member.decisionGraph);
                    const output = decisionRuntime.run(decisionInput);

                    // Interpret output: [steering, throttle, brake, risk]
                    const steering = (output[0] - 0.5) * (Math.PI / 3); // ±30°
                    const throttle = output[1];
                    const speed = throttle * 2.0; // max 2 m/s
                    const dt = 0.05; // 20 Hz simulation

                    // Update position
                    heading += steering * dt;
                    posX += Math.sin(heading) * speed * dt;
                    posZ += Math.cos(heading) * speed * dt;

                    // Collision check (simplified: any obstacle within 0.3m)
                    for (const obs of scenario.obstacles) {
                        const odx = posX - obs.center.x;
                        const odz = posZ - obs.center.z;
                        const dist = Math.sqrt(odx * odx + odz * odz);
                        const obsRadius = obs.radius ?? Math.max(obs.halfExtents?.x ?? 0.5, obs.halfExtents?.z ?? 0.5);
                        if (dist < obsRadius + 0.3) {
                            collisions++;
                        }
                    }

                    // Check if reached goal
                    const distToGoal = Math.sqrt((posX - goalX) ** 2 + (posZ - goalZ) ** 2);
                    if (distToGoal < 0.5) break; // close enough
                }

                const finalDist = Math.sqrt((posX - goalX) ** 2 + (posZ - goalZ) ** 2);
                totalFitness += fitness.evaluate(
                    finalDist,
                    collisions,
                    cfg.maxStepsPerScenario,
                    cfg.maxStepsPerScenario
                );
            }

            member.fitness = totalFitness / cfg.scenariosPerEval;
        }

        // ── Sort by fitness (descending) ──
        population.sort((a, b) => b.fitness - a.fitness);

        const bestFitness = population[0].fitness;
        const avgFitness = population.reduce((s, m) => s + m.fitness, 0) / population.length;
        const worstFitness = population[population.length - 1].fitness;

        // ── Track best overall ──
        if (bestFitness > bestOverallFitness) {
            bestOverallFitness = bestFitness;
            bestGeneration = gen;
            bestPerceptWeights = extractWeights(population[0].perceptGraph);
            bestPerceptBiases = extractBiases(population[0].perceptGraph);
            bestDecisionWeights = extractWeights(population[0].decisionGraph);
            bestDecisionBiases = extractBiases(population[0].decisionGraph);
        }

        // ── Selection + mutation ──
        // Elites survive unchanged; the rest are cloned from elites + mutated
        for (let i = eliteCount; i < cfg.populationSize; i++) {
            const parent = population[i % eliteCount]; // round-robin from elites

            // Clone parent weights
            cloneGraphWeights(parent.perceptGraph, population[i].perceptGraph);
            cloneGraphWeights(parent.decisionGraph, population[i].decisionGraph);

            // Mutate
            if (!cfg.freezePercept) {
                mutateGraph(population[i].perceptGraph, cfg.mutationWeightScale, cfg.mutationBiasScale);
            }
            mutateGraph(population[i].decisionGraph, cfg.mutationWeightScale, cfg.mutationBiasScale);
        }

        const genResult: IGenerationResult = {
            generation: gen,
            bestFitness,
            avgFitness,
            worstFitness,
            durationMs: performance.now() - genStart,
        };

        generationResults.push(genResult);
        cfg.onGenerationEnd?.(genResult);
    }

    return {
        generations: generationResults,
        bestFitness: bestOverallFitness,
        bestGeneration,
        totalDurationMs: performance.now() - totalStart,
        bestPerceptWeights,
        bestPerceptBiases,
        bestDecisionWeights,
        bestDecisionBiases,
    };
}
