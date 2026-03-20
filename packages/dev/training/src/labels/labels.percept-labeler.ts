// ═══════════════════════════════════════════════════════════════════════════
// Percept labeler — ground truth computation for PerceptCortex training
//
// Computes the 8 perception output labels from raw sensor data using the
// formal definitions in PerceptFeatureIndex. These labels are the
// supervised training targets for Phase 1 pre-training.
//
// Each function implements exactly the formula documented in
// navigation.interfaces.ts and navigation-architecture.md.
// ═══════════════════════════════════════════════════════════════════════════

import { ILidarSimConfig } from "@dev/training/scenario/scenario.interfaces";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Front sectors: 9–26 (central 180° of the 36-sector ring). */
const FRONT_START = 9;
const FRONT_END = 26;

/** Left sectors: 0–8. */
const LEFT_START = 0;
const LEFT_END = 8;

/** Right sectors: 27–35. */
const RIGHT_START = 27;
const RIGHT_END = 35;

/** Obstacle detection threshold as fraction of maxRange. */
const OBSTACLE_THRESHOLD_RATIO = 0.5;

// ─── Utility ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

function mean(arr: number[], from: number, to: number): number {
    let sum = 0;
    const count = to - from + 1;
    for (let i = from; i <= to; i++) {
        sum += arr[i];
    }
    return sum / count;
}

function minInRange(arr: number[], from: number, to: number): number {
    let m = Infinity;
    for (let i = from; i <= to; i++) {
        if (arr[i] < m) m = arr[i];
    }
    return m;
}

// ─── Individual feature computations ─────────────────────────────────────────

/**
 * [0] Front obstacle proximity: 0 (far) → 1 (contact).
 *
 * `clamp(1.0 − min(depth[9..26]) / maxRange, 0, 1)`
 */
function frontObstacleProximity(depths: number[], maxRange: number): number {
    const minFront = minInRange(depths, FRONT_START, FRONT_END);
    return clamp(1.0 - minFront / maxRange, 0, 1);
}

/**
 * [1] Front obstacle bearing: −1 (left) → +1 (right).
 *
 * Weighted angular centroid of close obstacles using inverse-depth weighting.
 */
function frontObstacleBearing(
    depths: number[],
    maxRange: number,
    horizontalFov: number,
    sectorCount: number
): number {
    const threshold = maxRange * OBSTACLE_THRESHOLD_RATIO;
    const halfFov = horizontalFov / 2;
    const sectorWidth = horizontalFov / sectorCount;

    let weightedSum = 0;
    let totalWeight = 0;

    for (let i = FRONT_START; i <= FRONT_END; i++) {
        if (depths[i] < threshold) {
            // Sector center angle relative to forward (0 = straight ahead)
            const angle = -halfFov + (i + 0.5) * sectorWidth;
            const weight = 1.0 / (depths[i] + 0.01); // +epsilon to avoid division by zero
            weightedSum += angle * weight;
            totalWeight += weight;
        }
    }

    if (totalWeight < 1e-6) return 0; // no obstacles detected

    const centroid = weightedSum / totalWeight;
    return clamp(centroid / halfFov, -1, 1);
}

/**
 * [2] Left clearance: 0 (wall) → 1 (open).
 *
 * `clamp(mean(depth[0..8]) / maxRange, 0, 1)`
 */
function leftClearance(depths: number[], maxRange: number): number {
    return clamp(mean(depths, LEFT_START, LEFT_END) / maxRange, 0, 1);
}

/**
 * [3] Right clearance: 0 (wall) → 1 (open).
 *
 * `clamp(mean(depth[27..35]) / maxRange, 0, 1)`
 */
function rightClearance(depths: number[], maxRange: number): number {
    return clamp(mean(depths, RIGHT_START, RIGHT_END) / maxRange, 0, 1);
}

/**
 * [4] Closing rate: −1 (approaching) → +1 (receding).
 *
 * Uses IMU forward acceleration as proxy.
 * Negative acceleration = decelerating/approaching, positive = accelerating away.
 *
 * We negate because: positive ax in body frame = accelerating forward,
 * but if you're accelerating toward an obstacle that means closing.
 * Convention: negative = closing, positive = receding.
 */
function closingRate(imu: readonly number[], maxAccel: number): number {
    // imu[2] = az = forward acceleration in body frame
    // Negative az = braking = receding from obstacle ahead
    // Positive az = accelerating forward = closing toward obstacle ahead
    return clamp(-imu[2] / maxAccel, -1, 1);
}

/**
 * [5] Corridor direction: −1 (best path left) → +1 (best path right).
 *
 * Direction of the sector with the deepest reading.
 */
function corridorDirection(
    depths: number[],
    horizontalFov: number,
    sectorCount: number
): number {
    const halfFov = horizontalFov / 2;
    const sectorWidth = horizontalFov / sectorCount;

    let bestIdx = 0;
    let bestDepth = -1;

    for (let i = 0; i < sectorCount; i++) {
        if (depths[i] > bestDepth) {
            bestDepth = depths[i];
            bestIdx = i;
        }
    }

    const bestAngle = -halfFov + (bestIdx + 0.5) * sectorWidth;
    return clamp(bestAngle / halfFov, -1, 1);
}

/**
 * [6] Terrain roughness: 0 (smooth) → 1 (rough).
 *
 * Computed from the magnitude of IMU acceleration deviation from gravity.
 * In a real system this would use a sliding window; for training labels
 * we use the single-sample deviation as a proxy.
 */
function terrainRoughness(imu: readonly number[], maxVariance: number): number {
    // Expected: ax≈0, ay≈-9.81 (gravity), az≈0 when stationary
    const devX = imu[0]; // any lateral acceleration = roughness
    const devY = imu[1] + 9.81; // deviation from gravity
    const devZ = imu[2]; // any forward jolt = roughness

    // Also include gyro readings as roughness indicator
    const gx = imu[3];
    const gy = imu[4];
    const gz = imu[5];

    const variance = devX * devX + devY * devY + devZ * devZ + gx * gx + gy * gy + gz * gz;
    return clamp(variance / maxVariance, 0, 1);
}

/**
 * [7] Confidence: 0 (unreliable) → 1 (high trust).
 *
 * Factors that reduce confidence:
 * - High variance across adjacent LiDAR sectors (noisy returns)
 * - IMU readings near saturation
 */
function confidence(depths: number[], imu: readonly number[], sectorCount: number): number {
    // Factor 1: LiDAR sector-to-sector variance (high = noisy)
    let lidarVariance = 0;
    for (let i = 1; i < sectorCount; i++) {
        const diff = depths[i] - depths[i - 1];
        lidarVariance += diff * diff;
    }
    lidarVariance /= sectorCount - 1;
    // Normalize: variance > 100 m² is "very noisy"
    const lidarNoise = clamp(lidarVariance / 100, 0, 1);

    // Factor 2: IMU saturation (readings near ±20g or ±2000°/s)
    const maxAccel = 196; // ±20g in m/s²
    const maxGyro = 35; // ±2000°/s in rad/s
    const accelMag = Math.sqrt(imu[0] * imu[0] + imu[1] * imu[1] + imu[2] * imu[2]);
    const gyroMag = Math.sqrt(imu[3] * imu[3] + imu[4] * imu[4] + imu[5] * imu[5]);
    const imuSaturation = clamp(Math.max(accelMag / maxAccel, gyroMag / maxGyro), 0, 1);

    // Combined noise score
    const noiseScore = 0.6 * lidarNoise + 0.4 * imuSaturation;
    return 1.0 - clamp(noiseScore, 0, 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for the percept labeler.
 */
export interface IPerceptLabelerConfig {
    /** Maximum LiDAR range in meters (default 100). */
    maxRange: number;

    /** Maximum expected acceleration for closingRate normalization (default 10 m/s²). */
    maxAccel: number;

    /** Maximum expected IMU variance for roughness normalization (default 50). */
    maxVariance: number;

    /** LiDAR configuration (for angular calculations). */
    lidarConfig: ILidarSimConfig;
}

/** Default labeler configuration. */
export const DEFAULT_LABELER_CONFIG: IPerceptLabelerConfig = {
    maxRange: 100,
    maxAccel: 10,
    maxVariance: 50,
    lidarConfig: {
        sectorCount: 36,
        horizontalFov: Math.PI,
        maxRange: 100,
        raysPerSector: 4,
    },
};

/**
 * Compute ground truth labels for all 8 perception outputs.
 *
 * @param depths   LiDAR sector depths (length = sectorCount, in meters).
 * @param imu      IMU reading: [ax, ay, az, gx, gy, gz].
 * @param config   Labeler configuration.
 * @returns        Array of 8 floats matching PerceptFeatureIndex order.
 */
export function computePerceptLabels(
    depths: number[],
    imu: readonly [number, number, number, number, number, number],
    config: IPerceptLabelerConfig = DEFAULT_LABELER_CONFIG
): number[] {
    const { maxRange, maxAccel, maxVariance, lidarConfig } = config;
    const { horizontalFov, sectorCount } = lidarConfig;

    return [
        /* [0] */ frontObstacleProximity(depths, maxRange),
        /* [1] */ frontObstacleBearing(depths, maxRange, horizontalFov, sectorCount),
        /* [2] */ leftClearance(depths, maxRange),
        /* [3] */ rightClearance(depths, maxRange),
        /* [4] */ closingRate(imu, maxAccel),
        /* [5] */ corridorDirection(depths, horizontalFov, sectorCount),
        /* [6] */ terrainRoughness(imu, maxVariance),
        /* [7] */ confidence(depths, imu, sectorCount),
    ];
}
