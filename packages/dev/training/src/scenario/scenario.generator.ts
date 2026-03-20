// ═══════════════════════════════════════════════════════════════════════════
// Scenario generator — procedural + MCP-injectable
//
// Two generator implementations:
//
// 1. RandomScenarioGenerator: pure procedural, fast, good for bulk data.
//    Generates random obstacle layouts within configurable constraints.
//
// 2. McpScenarioGenerator: extends random with an injection queue.
//    An LLM connected via MCP can push hand-designed scenarios into the
//    training pipeline and steer the random generator via constraints.
//    The MCP behavior would expose tools like:
//      - addScenario(scenario)       → inject a specific layout
//      - setConstraints(constraints) → steer random generation
//      - getPerformanceReport()      → read MLP weaknesses
// ═══════════════════════════════════════════════════════════════════════════

import {
    IMotionState,
    IObstacle,
    IMcpScenarioProvider,
    IPose,
    IScenario,
    IScenarioConstraints,
    IScenarioPerformanceReport,
    IScenarioProvider,
    IVec3,
    ObstacleType,
} from "./scenario.interfaces";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0;

function nextId(): string {
    return `scn_${++_idCounter}_${Date.now().toString(36)}`;
}

/** Random float in [min, max]. */
function randRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

/** Random element from an array. */
function randPick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

/** Random 3D position within a radius around the origin on the XZ plane. */
function randPositionXZ(minDist: number, maxDist: number, groundY: number): IVec3 {
    const angle = Math.random() * Math.PI * 2;
    const dist = randRange(minDist, maxDist);
    return {
        x: Math.cos(angle) * dist,
        y: groundY,
        z: Math.sin(angle) * dist,
    };
}

/** Generate a random obstacle of the given type near a position. */
function randomObstacle(type: ObstacleType, center: IVec3): IObstacle {
    switch (type) {
        case ObstacleType.Box:
            return {
                type,
                center: { x: center.x, y: center.y + randRange(0.2, 1.5), z: center.z },
                halfExtents: {
                    x: randRange(0.2, 2.0),
                    y: randRange(0.2, 2.0),
                    z: randRange(0.2, 2.0),
                },
            };

        case ObstacleType.Cylinder:
            return {
                type,
                center: { x: center.x, y: center.y + randRange(0.5, 2.0), z: center.z },
                radius: randRange(0.1, 1.5),
                height: randRange(0.5, 4.0),
            };

        case ObstacleType.Sphere:
            return {
                type,
                center: { x: center.x, y: center.y + randRange(0.3, 1.5), z: center.z },
                radius: randRange(0.2, 2.0),
            };

        case ObstacleType.Plane:
            // Rare — used for ramps or elevated platforms
            return {
                type,
                center,
                planeY: center.y + randRange(0.01, 0.5),
            };
    }
}

/** Generate a random motion state for IMU simulation. */
function randomMotion(roughness: number): IMotionState {
    const speed = randRange(0, 3); // 0–3 m/s
    return {
        linearVelocity: { x: 0, y: 0, z: speed },
        angularVelocity: {
            x: randRange(-0.1, 0.1) * roughness,
            y: randRange(-0.5, 0.5), // yaw rate
            z: randRange(-0.1, 0.1) * roughness,
        },
        linearAcceleration: {
            x: randRange(-1, 1) * roughness,
            y: -9.81 + randRange(-2, 2) * roughness, // gravity + vibration
            z: randRange(-1, 1),
        },
    };
}

// ─── Default constraints ─────────────────────────────────────────────────────

const DEFAULT_CONSTRAINTS: Required<IScenarioConstraints> = {
    minObstacles: 1,
    maxObstacles: 20,
    minObstacleDistance: 0.5,
    maxObstacleDistance: 50,
    allowedTypes: [ObstacleType.Box, ObstacleType.Cylinder, ObstacleType.Sphere],
    forcedSectors: [],
    minRoughness: 0,
    maxRoughness: 0.5,
    tags: [],
};

// ═══════════════════════════════════════════════════════════════════════════
// Random scenario generator
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Procedural scenario generator.
 *
 * Produces random obstacle layouts within configurable constraints.
 * Good for generating bulk training data. For targeted scenarios
 * (edge cases, specific difficulty levels), use McpScenarioGenerator.
 */
export class RandomScenarioGenerator implements IScenarioProvider {
    protected _constraints: Required<IScenarioConstraints>;

    constructor(constraints?: IScenarioConstraints) {
        this._constraints = {
            ...DEFAULT_CONSTRAINTS,
            ...(constraints ?? {}),
        } as Required<IScenarioConstraints>;
    }

    /** Generate a single random scenario. */
    public generate(): IScenario {
        const c = this._constraints;
        const groundY = 0;

        // Random rover pose (centered at origin, random heading)
        const pose: IPose = {
            position: { x: 0, y: 0.2, z: 0 }, // slightly above ground
            heading: randRange(0, Math.PI * 2),
            pitch: 0,
            roll: 0,
        };

        // Random obstacles
        const obstacleCount = Math.floor(randRange(c.minObstacles, c.maxObstacles + 1));
        const obstacles: IObstacle[] = [];

        for (let i = 0; i < obstacleCount; i++) {
            const type = randPick(c.allowedTypes);
            const center = randPositionXZ(c.minObstacleDistance, c.maxObstacleDistance, groundY);
            obstacles.push(randomObstacle(type, center));
        }

        // Force obstacles in specific sectors if required
        if (c.forcedSectors.length > 0) {
            const halfFov = Math.PI / 2; // 180° FOV → ±90°
            const sectorWidth = Math.PI / 36; // 36 sectors

            for (const sector of c.forcedSectors) {
                const angle = pose.heading + (-halfFov + (sector + 0.5) * sectorWidth);
                const dist = randRange(c.minObstacleDistance, Math.min(c.maxObstacleDistance, 10));
                const center: IVec3 = {
                    x: Math.sin(angle) * dist,
                    y: groundY,
                    z: Math.cos(angle) * dist,
                };
                obstacles.push(randomObstacle(randPick(c.allowedTypes), center));
            }
        }

        // Random motion for IMU
        const roughness = randRange(c.minRoughness, c.maxRoughness);
        const motion = randomMotion(roughness);

        // Optional goal (random point ahead of the rover)
        const goalDist = randRange(5, 50);
        const goalAngle = pose.heading + randRange(-Math.PI / 4, Math.PI / 4);
        const goal: IVec3 = {
            x: Math.sin(goalAngle) * goalDist,
            y: groundY,
            z: Math.cos(goalAngle) * goalDist,
        };

        return {
            id: nextId(),
            obstacles,
            groundY,
            pose,
            motion,
            goal,
            tags: [...c.tags],
        };
    }

    /** Generate a batch of independent scenarios. */
    public generateBatch(count: number): IScenario[] {
        const batch: IScenario[] = [];
        for (let i = 0; i < count; i++) {
            batch.push(this.generate());
        }
        return batch;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MCP-extensible scenario generator
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scenario generator with MCP injection support.
 *
 * Extends RandomScenarioGenerator with:
 * - An injection queue for LLM-designed scenarios
 * - Constraint steering for adaptive difficulty
 * - Performance reporting so the LLM can target weaknesses
 *
 * **MCP tool schema** (to be exposed by a McpScenarioBehavior):
 *
 * ```json
 * {
 *   "name": "training_add_scenario",
 *   "description": "Inject a hand-crafted training scenario",
 *   "inputSchema": { "$ref": "IScenario" }
 * }
 * {
 *   "name": "training_set_constraints",
 *   "description": "Steer the random generator toward specific configurations",
 *   "inputSchema": { "$ref": "IScenarioConstraints" }
 * }
 * {
 *   "name": "training_performance_report",
 *   "description": "Get MLP weakness analysis for targeted scenario design",
 *   "inputSchema": {}
 * }
 * ```
 */
export class McpScenarioGenerator extends RandomScenarioGenerator implements IMcpScenarioProvider {
    private readonly _injectedQueue: IScenario[] = [];
    private _performanceReport: IScenarioPerformanceReport = {
        totalEvaluated: 0,
        highRiskCount: 0,
        highErrorCount: 0,
        weaknessTags: [],
        perFeatureMSE: [0, 0, 0, 0, 0, 0, 0, 0],
    };

    constructor(constraints?: IScenarioConstraints) {
        super(constraints);
    }

    /**
     * Generate a scenario — serves injected scenarios first (FIFO),
     * then falls back to random generation.
     */
    public override generate(): IScenario {
        if (this._injectedQueue.length > 0) {
            return this._injectedQueue.shift()!;
        }
        return super.generate();
    }

    /** Inject a scenario from an external source (LLM via MCP). */
    public addScenario(scenario: IScenario): void {
        // Ensure the scenario has an ID
        if (!scenario.id) {
            scenario.id = nextId();
        }
        this._injectedQueue.push(scenario);
    }

    /** Update generation constraints (called by MCP to steer difficulty). */
    public setConstraints(constraints: IScenarioConstraints): void {
        this._constraints = {
            ...this._constraints,
            ...constraints,
        } as Required<IScenarioConstraints>;
    }

    /** Get the current performance report. */
    public getPerformanceReport(): IScenarioPerformanceReport {
        return { ...this._performanceReport };
    }

    /**
     * Update performance metrics.
     * Called by the training loop after each evaluation batch.
     * @internal
     */
    public updatePerformance(report: Partial<IScenarioPerformanceReport>): void {
        Object.assign(this._performanceReport, report);
    }
}
