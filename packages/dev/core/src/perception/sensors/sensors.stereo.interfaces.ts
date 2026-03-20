// ═══════════════════════════════════════════════════════════════════════════
// Stereo vision interfaces — passive depth from camera pairs
//
// Stereoscopic depth estimation produces an IDepthBuffer from two
// offset cameras, using the same interface as the LiDAR depth pipeline.
// This makes the entire downstream chain (convolution → PerceptCortex)
// work identically regardless of depth source.
//
// Real-world rationale:
// - Mars rovers (Curiosity, Perseverance) use stereo NavCams as primary
//   navigation sensor — passive, low power, no moving parts.
// - LiDAR is reserved for precise geological surveys and night ops.
// - Stereo provides dense depth + RGB texture at low energy cost.
// ═══════════════════════════════════════════════════════════════════════════

import { IRecord } from "@dev/core/telemetry";
import { IDepthBufferProvider } from "./sensors.depth-pipeline.interfaces";
import { ISensorEventEmitter, ISensorNode, ISensorReadable } from "./sensors.interfaces";

// ─── Stereo configuration ────────────────────────────────────────────────────

/**
 * Physical configuration of a stereo camera pair.
 */
export interface IStereoConfig {
    /**
     * Baseline: horizontal distance between the two camera optical centers,
     * in scene units. Larger baseline = better depth accuracy at distance,
     * but wider minimum detection range (near objects fall outside overlap).
     *
     * Typical values:
     * - Small rover: 0.1–0.2 m
     * - Mars rover (NavCam): ~0.42 m
     * - Autonomous car: 0.5–1.2 m
     */
    baseline: number;

    /**
     * Focal length in pixels.
     * `focalLengthPx = focalLengthMm * imageWidth / sensorWidthMm`
     *
     * Used in the depth formula: `depth = baseline * focalLengthPx / disparity`
     */
    focalLengthPx: number;

    /** Image width in pixels (both cameras must match). */
    imageWidth: number;

    /** Image height in pixels (both cameras must match). */
    imageHeight: number;

    /**
     * Minimum reliable disparity in pixels.
     * Corresponds to the maximum measurable depth:
     * `maxDepth = baseline * focalLengthPx / minDisparity`
     * Default: 1.
     */
    minDisparity?: number;

    /**
     * Maximum disparity in pixels.
     * Corresponds to the minimum measurable depth:
     * `minDepth = baseline * focalLengthPx / maxDisparity`
     * Default: 128.
     */
    maxDisparity?: number;
}

// ─── Disparity map ───────────────────────────────────────────────────────────

/**
 * Raw disparity map output from stereo matching.
 *
 * Disparity is the horizontal pixel offset between corresponding points
 * in the left and right images. Depth is inversely proportional:
 * `depth = baseline * focalLengthPx / disparity`
 *
 * Values:
 * - > 0: valid match (higher = closer)
 * - 0: no match found (occluded, textureless, or out of range)
 */
export interface IDisparityMap {
    /** Disparity values in pixels. Length = width * height. Row-major. */
    data: Float32Array;

    /** Map width (same as stereo image width). */
    width: number;

    /** Map height (same as stereo image height). */
    height: number;

    /**
     * Confidence map (optional). Same dimensions as disparity.
     * Values in [0, 1]: 0 = no confidence, 1 = perfect match.
     * Low confidence areas (textureless walls, reflections) should
     * be treated as unreliable depth.
     */
    confidence?: Float32Array;
}

// ─── Stereo matching strategy ────────────────────────────────────────────────

/**
 * Strategy for computing disparity from a rectified stereo pair.
 *
 * Implementations:
 * - **BlockMatching**: classic SAD/SSD block matching (CPU, fast, noisy)
 * - **SemiGlobalMatching**: SGM (CPU, better quality, slower)
 * - **GPUStereoMatching**: WebGL/WebGPU compute shader (real-time)
 * - **MathStereoMatching**: simplified for training data generation
 */
export interface IStereoMatcher {
    /**
     * Compute disparity from a rectified stereo pair.
     *
     * @param left    Left image (grayscale, Float32Array, row-major).
     * @param right   Right image (grayscale, Float32Array, row-major).
     * @param config  Stereo configuration (baseline, focal, disparity range).
     * @returns       Disparity map.
     */
    computeDisparity(
        left: Float32Array,
        right: Float32Array,
        config: IStereoConfig
    ): IDisparityMap;
}

// ─── Stereo depth provider ───────────────────────────────────────────────────

/**
 * Context for stereo depth rendering.
 * Framework-specific — contains references to the two cameras or images.
 */
export interface IStereoContext<TCamera = unknown> {
    /** Left camera or image source. */
    left: TCamera;

    /** Right camera or image source. */
    right: TCamera;

    /** Stereo rig configuration. */
    config: IStereoConfig;
}

/**
 * Stereo depth buffer provider.
 *
 * Produces an `IDepthBuffer` from a stereo camera pair by:
 * 1. Capturing left and right images
 * 2. Rectifying (correcting lens distortion and aligning epipolar lines)
 * 3. Computing disparity via `IStereoMatcher`
 * 4. Converting disparity → depth: `depth = baseline * focalPx / disparity`
 * 5. Normalizing to [0, 1] for `IDepthBuffer`
 *
 * Plugs into the same `IConvolutionProvider` pipeline as LiDAR depth,
 * so all downstream processing (sectors → PerceptCortex) is identical.
 */
export interface IStereoDepthProvider<TCamera = unknown> extends IDepthBufferProvider<IStereoContext<TCamera>> {
    /** The stereo matcher used for disparity computation. */
    readonly matcher: IStereoMatcher;

    /** The stereo rig configuration. */
    readonly config: IStereoConfig;

    /**
     * Access the last computed disparity map (for debugging/visualization).
     */
    readonly lastDisparityMap: IDisparityMap | null;
}

// ─── Stereo scan result ──────────────────────────────────────────────────────

/**
 * Result of a stereo depth scan.
 * Matches `ILidarScanResult` structure so consumers can handle both
 * depth sources uniformly.
 */
export interface IStereoScanResult {
    /** Depth values in scene units as Float32Array. 0 = no match. */
    data: Float32Array;

    /** Stereo-specific metadata. */
    metadata: IStereoScanMetadata;
}

/**
 * Metadata for a stereo depth scan.
 */
export interface IStereoScanMetadata {
    /** Image width used for matching. */
    imageWidth: number;

    /** Image height used for matching. */
    imageHeight: number;

    /** Baseline in scene units. */
    baseline: number;

    /** Focal length in pixels. */
    focalLengthPx: number;

    /** Minimum reliable depth in scene units. */
    minDepth: number;

    /** Maximum reliable depth in scene units. */
    maxDepth: number;

    /**
     * Average match confidence [0, 1].
     * Low values indicate poor texture or lighting conditions.
     */
    averageConfidence: number;
}

// ─── Stereo sensor node ──────────────────────────────────────────────────────

export interface IStereoEvent extends IRecord<IStereoScanResult> {}

/**
 * Stereo depth sensor node in the simulation tree.
 *
 * Decorates two cameras, produces depth via stereo matching,
 * and feeds into the same depth pipeline as LiDAR.
 */
export interface IStereoNode extends ISensorNode, ISensorReadable<IStereoScanResult>, ISensorEventEmitter<IStereoEvent> {
    /** The stereo rig configuration. */
    readonly config: IStereoConfig;

    /** Whether the stereo pair has sufficient light/texture for reliable depth. */
    readonly isHealthy: boolean;

    /** Perform a stereo depth scan. */
    scan(): IStereoScanResult;
}
