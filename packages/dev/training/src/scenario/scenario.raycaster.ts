// ═══════════════════════════════════════════════════════════════════════════
// Pure-math raycaster — no 3D engine dependency
//
// Computes ray-primitive intersections for simulated LiDAR scans.
// All geometry is axis-aligned (no rotation matrices needed).
//
// Performance: a full 36-sector scan with 4 rays/sector against 20
// obstacles takes < 0.1ms on a modern CPU. Fast enough to generate
// millions of training samples without a GPU.
// ═══════════════════════════════════════════════════════════════════════════

import {
    IDepthBuffer,
    IDepthBufferProvider,
    IConvolutionConfig,
    IConvolutionProvider,
    IDepthPipeline,
    MathConvolution,
} from "@dev/core/perception";

import {
    ILidarSimConfig,
    IMotionState,
    IObstacle,
    IPose,
    IScenario,
    ISensorSimulator,
    IVec3,
    ObstacleType,
} from "./scenario.interfaces";

// ─── Vector helpers (inline for zero-allocation) ─────────────────────────────

function vec3(x: number, y: number, z: number): IVec3 {
    return { x, y, z };
}

function dot(a: IVec3, b: IVec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function sub(a: IVec3, b: IVec3): IVec3 {
    return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ─── Ray-primitive intersection ──────────────────────────────────────────────

/**
 * Ray-AABB intersection (slab method).
 * Returns the distance along the ray to the nearest intersection,
 * or Infinity if no hit.
 */
function rayBox(
    origin: IVec3,
    dir: IVec3,
    center: IVec3,
    halfExtents: IVec3,
    maxRange: number
): number {
    const minX = center.x - halfExtents.x;
    const maxX = center.x + halfExtents.x;
    const minY = center.y - halfExtents.y;
    const maxY = center.y + halfExtents.y;
    const minZ = center.z - halfExtents.z;
    const maxZ = center.z + halfExtents.z;

    // Slab method — compute entry/exit t for each axis
    let tMin = -Infinity;
    let tMax = Infinity;

    // X slab
    if (Math.abs(dir.x) > 1e-10) {
        const t1 = (minX - origin.x) / dir.x;
        const t2 = (maxX - origin.x) / dir.x;
        tMin = Math.max(tMin, Math.min(t1, t2));
        tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (origin.x < minX || origin.x > maxX) {
        return Infinity;
    }

    // Y slab
    if (Math.abs(dir.y) > 1e-10) {
        const t1 = (minY - origin.y) / dir.y;
        const t2 = (maxY - origin.y) / dir.y;
        tMin = Math.max(tMin, Math.min(t1, t2));
        tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (origin.y < minY || origin.y > maxY) {
        return Infinity;
    }

    // Z slab
    if (Math.abs(dir.z) > 1e-10) {
        const t1 = (minZ - origin.z) / dir.z;
        const t2 = (maxZ - origin.z) / dir.z;
        tMin = Math.max(tMin, Math.min(t1, t2));
        tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (origin.z < minZ || origin.z > maxZ) {
        return Infinity;
    }

    if (tMax < 0 || tMin > tMax || tMin > maxRange) {
        return Infinity;
    }

    return tMin > 0 ? tMin : tMax > 0 ? tMax : Infinity;
}

/**
 * Ray-sphere intersection.
 * Returns distance to nearest hit, or Infinity.
 */
function raySphere(
    origin: IVec3,
    dir: IVec3,
    center: IVec3,
    radius: number,
    maxRange: number
): number {
    const oc = sub(origin, center);
    const a = dot(dir, dir);
    const b = 2 * dot(oc, dir);
    const c = dot(oc, oc) - radius * radius;
    const disc = b * b - 4 * a * c;

    if (disc < 0) return Infinity;

    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-b - sqrtDisc) / (2 * a);
    const t2 = (-b + sqrtDisc) / (2 * a);

    if (t1 > 0 && t1 <= maxRange) return t1;
    if (t2 > 0 && t2 <= maxRange) return t2;
    return Infinity;
}

/**
 * Ray-cylinder intersection (vertical, axis-aligned along Y).
 * Tests the infinite cylinder then clips to the finite height.
 */
function rayCylinder(
    origin: IVec3,
    dir: IVec3,
    center: IVec3,
    radius: number,
    height: number,
    maxRange: number
): number {
    const halfH = height / 2;
    const yMin = center.y - halfH;
    const yMax = center.y + halfH;

    // Project onto XZ plane for infinite cylinder test
    const dx = origin.x - center.x;
    const dz = origin.z - center.z;
    const a = dir.x * dir.x + dir.z * dir.z;
    const b = 2 * (dx * dir.x + dz * dir.z);
    const c = dx * dx + dz * dz - radius * radius;
    const disc = b * b - 4 * a * c;

    let tBest = Infinity;

    // Side surface intersection
    if (disc >= 0 && a > 1e-10) {
        const sqrtDisc = Math.sqrt(disc);
        const t1 = (-b - sqrtDisc) / (2 * a);
        const t2 = (-b + sqrtDisc) / (2 * a);

        for (const t of [t1, t2]) {
            if (t > 0 && t <= maxRange) {
                const y = origin.y + t * dir.y;
                if (y >= yMin && y <= yMax && t < tBest) {
                    tBest = t;
                }
            }
        }
    }

    // Cap intersections (top and bottom discs)
    if (Math.abs(dir.y) > 1e-10) {
        for (const capY of [yMin, yMax]) {
            const t = (capY - origin.y) / dir.y;
            if (t > 0 && t <= maxRange && t < tBest) {
                const hx = origin.x + t * dir.x - center.x;
                const hz = origin.z + t * dir.z - center.z;
                if (hx * hx + hz * hz <= radius * radius) {
                    tBest = t;
                }
            }
        }
    }

    return tBest;
}

/**
 * Ray-plane intersection (horizontal plane at a given Y).
 */
function rayPlane(
    origin: IVec3,
    dir: IVec3,
    planeY: number,
    maxRange: number
): number {
    if (Math.abs(dir.y) < 1e-10) return Infinity;
    const t = (planeY - origin.y) / dir.y;
    return t > 0 && t <= maxRange ? t : Infinity;
}

// ─── Raycaster ───────────────────────────────────────────────────────────────

/**
 * Cast a single ray against all obstacles in the scenario.
 * @returns Distance to nearest hit (meters), or maxRange if no hit.
 */
function castRay(
    origin: IVec3,
    dir: IVec3,
    obstacles: IObstacle[],
    groundY: number,
    maxRange: number
): number {
    let closest = maxRange;

    // Ground plane
    const tGround = rayPlane(origin, dir, groundY, maxRange);
    if (tGround < closest) closest = tGround;

    // Obstacles
    for (let i = 0; i < obstacles.length; i++) {
        const obs = obstacles[i];
        let t = Infinity;

        switch (obs.type) {
            case ObstacleType.Box:
                t = rayBox(origin, dir, obs.center, obs.halfExtents!, maxRange);
                break;
            case ObstacleType.Sphere:
                t = raySphere(origin, dir, obs.center, obs.radius!, maxRange);
                break;
            case ObstacleType.Cylinder:
                t = rayCylinder(origin, dir, obs.center, obs.radius!, obs.height!, maxRange);
                break;
            case ObstacleType.Plane:
                t = rayPlane(origin, dir, obs.planeY ?? obs.center.y, maxRange);
                break;
        }

        if (t < closest) closest = t;
    }

    return closest;
}

/**
 * Simulate a full LiDAR scan from a given pose in a scenario.
 *
 * Produces an array of `sectorCount` depth values, each being the minimum
 * depth detected across `raysPerSector` sub-rays within that sector's
 * angular range. This matches the PerceptCortex input layout.
 *
 * @param scenario  The scenario containing obstacles and ground.
 * @param pose      Rover pose (position + heading + pitch + roll).
 * @param config    LiDAR simulation configuration.
 * @returns         Array of `sectorCount` depth values in meters.
 *                  Each value is in [0, maxRange]. 0 means no return
 *                  (ray missed everything within maxRange).
 */
export function simulateLidar(
    scenario: IScenario,
    pose: IPose,
    config: ILidarSimConfig
): number[] {
    const { sectorCount, horizontalFov, maxRange, raysPerSector } = config;
    const depths = new Array<number>(sectorCount);

    // Precompute heading rotation (Y-axis rotation in XZ plane)
    const cosH = Math.cos(pose.heading);
    const sinH = Math.sin(pose.heading);

    // Sensor origin (slightly above ground to simulate real LiDAR mount)
    const origin = vec3(
        pose.position.x,
        pose.position.y + 0.3, // typical mount height on small rover
        pose.position.z
    );

    const halfFov = horizontalFov / 2;
    const sectorWidth = horizontalFov / sectorCount;

    for (let s = 0; s < sectorCount; s++) {
        let minDepth = maxRange;

        // Angular range for this sector
        const sectorStart = -halfFov + s * sectorWidth;

        for (let r = 0; r < raysPerSector; r++) {
            // Evenly distribute rays within the sector
            const angle = sectorStart + (r + 0.5) * (sectorWidth / raysPerSector);

            // Ray direction in world space (rotated by heading)
            // Local forward = +Z, local right = +X
            const localX = Math.sin(angle);
            const localZ = Math.cos(angle);

            const dir = vec3(
                localX * cosH + localZ * sinH,
                0, // horizontal LiDAR plane (pitch/roll ignored for simplicity)
                -localX * sinH + localZ * cosH
            );

            const d = castRay(origin, dir, scenario.obstacles, scenario.groundY, maxRange);
            if (d < minDepth) minDepth = d;
        }

        depths[s] = minDepth;
    }

    return depths;
}

/**
 * Simulate IMU readings from a motion state.
 *
 * Produces a 6-element array matching the PerceptCortex input layout:
 * [ax, ay, az, gx, gy, gz]
 *
 * In a real IMU:
 * - Accelerometer measures linear acceleration + gravity (body frame)
 * - Gyroscope measures angular velocity (body frame)
 *
 * For training, we add configurable noise to simulate sensor imperfection.
 *
 * @param motion    Current motion state.
 * @param noise     Standard deviation of Gaussian noise added to each axis.
 *                  Default: 0.02 (realistic MEMS IMU noise).
 * @returns         [ax, ay, az, gx, gy, gz] in body frame.
 */
export function simulateIMU(
    motion: IMotionState,
    noise: number = 0.02
): [number, number, number, number, number, number] {
    const accel = motion.linearAcceleration;
    const gyro = motion.angularVelocity;

    // Add Gaussian noise (Box-Muller transform)
    const n = (): number => {
        const u1 = Math.random();
        const u2 = Math.random();
        return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2) * noise;
    };

    return [
        accel.x + n(),
        accel.y + n(),
        accel.z + n(),
        gyro.x + n(),
        gyro.y + n(),
        gyro.z + n(),
    ];
}

/**
 * Default LiDAR configuration matching the PerceptCortex input layout.
 */
export const DEFAULT_LIDAR_CONFIG: ILidarSimConfig = {
    sectorCount: 36,
    horizontalFov: Math.PI, // 180°
    maxRange: 100,
    raysPerSector: 4,
};

// ═══════════════════════════════════════════════════════════════════════════
// IDepthBufferProvider implementation — CPU raycasting to depth buffer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Context for the math depth renderer: a scenario + pose.
 */
export interface IMathDepthContext {
    scenario: IScenario;
    pose: IPose;
    /** Horizontal FOV in radians. */
    horizontalFov: number;
    /** Vertical FOV in radians. */
    verticalFov: number;
    /** Near plane distance in meters. */
    near: number;
    /** Far plane distance in meters. */
    far: number;
}

/**
 * CPU-based depth buffer renderer using ray-primitive intersection.
 *
 * Produces a virtual depth buffer by casting rays in a grid pattern,
 * matching exactly what a GPU would produce via rasterization.
 *
 * The output is a normalized [0,1] `IDepthBuffer` that can then be
 * downsampled by any `IConvolutionProvider` (CPU or GPU).
 *
 * **Use case**: offline training data generation. No GPU, no framework.
 *
 * **Limitations**: only axis-aligned primitives. For complex meshes,
 * use a GPU-based `IDepthBufferProvider` (BabylonDepthReader, etc.).
 */
export class MathDepthRenderer implements IDepthBufferProvider<IMathDepthContext> {
    /**
     * Render a depth buffer by raycasting against scenario geometry.
     *
     * Each pixel corresponds to a ray direction based on the camera
     * FOV and the requested resolution. The output is normalized [0,1]
     * where 0 = near plane, 1 = far plane.
     */
    public render(context: IMathDepthContext, width: number, height: number): IDepthBuffer {
        const { scenario, pose, horizontalFov, verticalFov, near, far } = context;
        const data = new Float32Array(width * height);
        const range = far - near;

        const cosH = Math.cos(pose.heading);
        const sinH = Math.sin(pose.heading);

        const origin = vec3(
            pose.position.x,
            pose.position.y + 0.3,
            pose.position.z
        );

        const halfHFov = horizontalFov / 2;
        const halfVFov = verticalFov / 2;

        for (let row = 0; row < height; row++) {
            // Vertical angle: top of buffer = +halfVFov, bottom = -halfVFov
            const vAngle = halfVFov - (row / (height - 1 || 1)) * (2 * halfVFov);

            for (let col = 0; col < width; col++) {
                // Horizontal angle: left = -halfHFov, right = +halfHFov
                const hAngle = -halfHFov + (col / (width - 1 || 1)) * (2 * halfHFov);

                // Ray direction in local space
                const cosV = Math.cos(vAngle);
                const localX = Math.sin(hAngle) * cosV;
                const localY = Math.sin(vAngle);
                const localZ = Math.cos(hAngle) * cosV;

                // Rotate by heading (Y-axis rotation in XZ plane)
                const dir = vec3(
                    localX * cosH + localZ * sinH,
                    localY,
                    -localX * sinH + localZ * cosH
                );

                const dist = castRay(origin, dir, scenario.obstacles, scenario.groundY, far);

                // Normalize to [0, 1]: 0 = near, 1 = far
                const normalized = Math.min(Math.max((dist - near) / range, 0), 1);
                data[row * width + col] = normalized;
            }
        }

        return { data, width, height, near, far };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MathDepthPipeline — full depth buffer → convolution → sectors (CPU)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Complete CPU pipeline: raycast → depth buffer → convolve → sector depths.
 *
 * Composes `MathDepthRenderer` + `MathConvolution` (or any override).
 *
 * ```typescript
 * const pipeline = new MathDepthPipeline();
 *
 * const sectors = pipeline.execute(
 *     { scenario, pose, horizontalFov: Math.PI, verticalFov: 0.1, near: 0.1, far: 100 },
 *     { cols: 36, rows: 1, pooling: "min", maxRange: 100 },
 *     256, 16  // buffer resolution
 * );
 * // sectors: Float32Array of 36 depth values in meters
 * ```
 */
export class MathDepthPipeline implements IDepthPipeline<IMathDepthContext> {
    public readonly depthProvider: MathDepthRenderer;
    public readonly convolution: IConvolutionProvider;

    constructor(convolution?: IConvolutionProvider) {
        this.depthProvider = new MathDepthRenderer();
        this.convolution = convolution ?? new MathConvolution();
    }

    /**
     * Execute: render depth buffer → downsample → sector depths.
     */
    public execute(
        context: IMathDepthContext,
        config: IConvolutionConfig,
        bufferW: number = 256,
        bufferH: number = 16
    ): Float32Array {
        const buffer = this.depthProvider.render(context, bufferW, bufferH);
        return this.convolution.downsample(buffer, config);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ISensorSimulator implementation — wraps the depth pipeline
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure-math sensor simulator using the depth pipeline.
 *
 * Internally: raycast → depth buffer → convolution → sector depths.
 * Same pipeline architecture as the GPU-based implementations, just
 * with CPU math at each stage.
 */
export class MathSensorSimulator implements ISensorSimulator {
    private readonly _pipeline: MathDepthPipeline;

    constructor(convolution?: IConvolutionProvider) {
        this._pipeline = new MathDepthPipeline(convolution);
    }

    /** Simulate LiDAR via depth pipeline: raycast → buffer → convolve. */
    public simulateLidar(scenario: IScenario, pose: IPose, config: ILidarSimConfig): number[] {
        const context: IMathDepthContext = {
            scenario,
            pose,
            horizontalFov: config.horizontalFov,
            verticalFov: 0.1, // thin horizontal beam for 2D LiDAR
            near: 0.1,
            far: config.maxRange,
        };

        const convConfig: IConvolutionConfig = {
            cols: config.sectorCount,
            rows: 1, // single beam row
            pooling: "min", // closest obstacle per sector
            maxRange: config.maxRange,
        };

        // Buffer resolution: more columns than sectors for oversampling
        const bufferW = config.sectorCount * config.raysPerSector;
        const bufferH = 1;

        const grid = this._pipeline.execute(context, convConfig, bufferW, bufferH);
        return Array.from(grid);
    }

    /** Simulate IMU from motion state with Gaussian noise. */
    public simulateIMU(
        motion: IMotionState,
        noise: number = 0.02
    ): [number, number, number, number, number, number] {
        return simulateIMU(motion, noise);
    }
}
