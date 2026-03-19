import { IRecord } from "@dev/core/telemetry";
import { ISensorEventEmitter, ISensorNode, ISensorReadable } from "./sensors.interfaces";

/**
 * Standard vertical beam counts matching real lidar tiers.
 */
export type LidarBeams = 16 | 32 | 64 | 128;

/**
 * Depth encoding format.
 * - `uint16`: millimeters as Uint16Array (compact, 0–65535 mm range).
 * - `float32`: meters as Float32Array (full precision).
 */
export type LidarEncoding = "uint16" | "float32";

/**
 * Configuration for a lidar scan request.
 */
export interface ILidarScanOptions {
    /** Camera URI to capture the depth buffer from. */
    uri: string;

    /** Number of vertical channels (rows). Standard lidar tiers: 16, 32, 64, or 128. Defaults to 16. */
    beams?: LidarBeams;

    /**
     * Horizontal angular step in degrees.
     * Columns = floor(hFov / angularResolution).
     * Smaller values produce denser horizontal sampling. Defaults to 1.0.
     */
    angularResolution?: number;

    /** Depth encoding format. Defaults to 'uint16'. */
    encoding?: LidarEncoding;

    /**
     * Maximum lidar range in meters.
     * Depth values beyond this distance are reported as 0 (no return),
     * matching real lidar behavior for sky or out-of-range hits. Defaults to 100.
     */
    maxRange?: number;
}

/**
 * Metadata returned alongside a lidar depth grid.
 */
export interface ILidarScanMetadata {
    /** Number of vertical beams (rows) in the grid. */
    beams: LidarBeams;

    /** Number of horizontal columns in the grid. */
    columns: number;

    /** Near clipping plane distance in meters. */
    nearPlane: number;

    /** Far clipping plane distance in meters. */
    farPlane: number;

    /** Horizontal field of view in degrees. */
    hFov: number;

    /** Encoding used for the depth data. */
    encoding: LidarEncoding;
}

/**
 * Result of a lidar-style depth scan: base64-encoded depth values with metadata.
 */
export interface ILidarScanResult {
    /** Base64-encoded depth values (Uint16Array or Float32Array depending on encoding). */
    data: string;

    /** Scan metadata describing grid dimensions, planes, FOV, and encoding. */
    metadata: ILidarScanMetadata;
}

export interface ILidarEvent extends IRecord<ILidarScanResult> {}

export interface ILidarNode extends ISensorNode, ISensorReadable<ILidarScanResult>, ISensorEventEmitter<ILidarEvent> {
    scan(options: ILidarScanOptions): ILidarScanResult;
}
