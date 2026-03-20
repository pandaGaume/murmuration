// ═══════════════════════════════════════════════════════════════════════════
// Math stereo simulator — synthetic stereo depth for training
//
// Simulates a stereo camera pair by raycasting from two offset positions
// (separated by baseline), then computing the depth buffer from the
// virtual disparity.
//
// This is a simplified model that skips actual image matching — it
// produces the "ideal" stereo depth plus configurable noise to simulate
// real-world matching errors (textureless regions, occlusions, etc.).
//
// Used by the training pipeline to generate stereo-based training
// samples without a 3D engine.
// ═══════════════════════════════════════════════════════════════════════════

import { IDepthBuffer } from "@dev/core/perception";
import { IScenario, IPose } from "./scenario.interfaces";
import { simulateLidar } from "./scenario.raycaster";

/**
 * Configuration for the simulated stereo pair.
 */
export interface IMathStereoConfig {
    /** Baseline distance between cameras in scene units. */
    baseline: number;

    /** Output depth buffer width in pixels. */
    width: number;

    /** Output depth buffer height in pixels. */
    height: number;

    /** Horizontal FOV in radians. */
    horizontalFov: number;

    /** Maximum depth range in scene units. */
    maxRange: number;

    /**
     * Noise standard deviation (fraction of depth).
     * Simulates stereo matching errors. 0 = perfect, 0.02 = 2% noise.
     * Real stereo typically has 1–5% depth noise.
     * Default: 0.02.
     */
    depthNoise: number;

    /**
     * Probability of a pixel having no valid match (occlusion/textureless).
     * Simulates regions where stereo matching fails.
     * 0 = never, 0.05 = 5% of pixels invalid.
     * Default: 0.03.
     */
    dropoutRate: number;
}

/** Default stereo simulation config. */
export const DEFAULT_STEREO_CONFIG: IMathStereoConfig = {
    baseline: 0.42, // Mars rover NavCam baseline
    width: 256,
    height: 192,
    horizontalFov: Math.PI * 0.75, // 135 degrees
    maxRange: 100,
    depthNoise: 0.02,
    dropoutRate: 0.03,
};

/**
 * Simulate a stereo depth buffer from two virtual cameras.
 *
 * Algorithm:
 * 1. Position left camera at pose.position - baseline/2 (lateral offset)
 * 2. Position right camera at pose.position + baseline/2
 * 3. Raycast from left camera to get ground-truth depth per pixel
 * 4. Add depth-proportional Gaussian noise (stereo matching error)
 * 5. Random dropout for textureless/occluded regions
 * 6. Normalize to [0, 1] for IDepthBuffer
 *
 * The left-camera depth is used as primary since stereo matching
 * produces depth referenced to the left camera by convention.
 *
 * @param scenario  Scene geometry.
 * @param pose      Rover center pose (cameras are offset by ±baseline/2).
 * @param config    Stereo simulation parameters.
 * @returns         IDepthBuffer compatible with the convolution pipeline.
 */
export function simulateStereoDepth(
    scenario: IScenario,
    pose: IPose,
    config: IMathStereoConfig = DEFAULT_STEREO_CONFIG
): IDepthBuffer {
    const { baseline, width, height, horizontalFov, maxRange, depthNoise, dropoutRate } = config;

    // Left camera: offset by -baseline/2 perpendicular to heading
    const perpX = -Math.cos(pose.heading); // perpendicular in XZ plane
    const perpZ = Math.sin(pose.heading);
    const halfBase = baseline / 2;

    const leftPose: IPose = {
        ...pose,
        position: {
            x: pose.position.x + perpX * halfBase,
            y: pose.position.y,
            z: pose.position.z + perpZ * halfBase,
        },
    };

    // Use the LiDAR raycaster at full resolution to get per-pixel depth
    // (treating each pixel column as a LiDAR sector)
    const lidarConfig = {
        sectorCount: width,
        horizontalFov,
        maxRange,
        raysPerSector: 1,
    };

    // Get one row of depths from the left camera
    const leftDepths = simulateLidar(scenario, leftPose, lidarConfig);

    // Build full depth buffer (replicate single row vertically with slight variation)
    const data = new Float32Array(width * height);
    const range = maxRange;

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            let depth = leftDepths[col];

            // Stereo dropout: textureless regions produce no match
            if (Math.random() < dropoutRate) {
                data[row * width + col] = 1.0; // far plane = no match
                continue;
            }

            // Depth-proportional noise: error grows with distance (real stereo behavior)
            if (depthNoise > 0 && depth < maxRange) {
                const u1 = Math.random();
                const u2 = Math.random();
                const gaussian = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
                depth += depth * depthNoise * gaussian;
                depth = Math.max(0, depth);
            }

            // Slight vertical variation (terrain is not flat)
            const vNoise = 1.0 + (row / height - 0.5) * 0.02;
            depth *= vNoise;

            // Normalize to [0, 1]
            const normalized = Math.min(Math.max(depth / range, 0), 1);
            data[row * width + col] = normalized;
        }
    }

    return {
        data,
        width,
        height,
        near: 0.1,
        far: maxRange,
    };
}

/**
 * Estimate stereo confidence from scenario geometry.
 *
 * Real stereo matching fails on:
 * - Textureless surfaces (flat walls, sky)
 * - Reflective surfaces
 * - Repeated patterns
 * - Occluded regions (visible to one camera but not the other)
 *
 * This simplified model returns lower confidence when:
 * - Depth is near maxRange (sky/far objects = textureless)
 * - Depth variance across neighboring pixels is very low (flat surface)
 *
 * @param depthBuffer  The simulated stereo depth buffer.
 * @returns            Average confidence [0, 1].
 */
export function estimateStereoConfidence(depthBuffer: IDepthBuffer): number {
    const { data, width, height } = depthBuffer;
    let totalConf = 0;
    let count = 0;

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const d = data[row * width + col];

            // Sky/far: low confidence
            if (d >= 0.95) {
                totalConf += 0.1;
            }
            // Near objects with texture: high confidence
            else if (d < 0.5) {
                totalConf += 0.95;
            }
            // Mid-range: moderate
            else {
                totalConf += 0.7;
            }
            count++;
        }
    }

    return count > 0 ? totalConf / count : 0;
}
