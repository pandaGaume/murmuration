import { IRecord } from "@dev/core/telemetry";
import { ISensorEventEmitter, ISensorNode, ISensorReadable } from "./sensors.interfaces";

/**
 * Standard vertical beam counts matching real lidar tiers.
 */
export type LidarBeams = 16 | 32 | 64 | 128;

/**
 * Depth encoding format and unit.
 *
 * - `"float32"`: meters as Float32Array. Full precision, used for
 *   simulation, training, and internal processing.
 *
 * - `"uint16"`: millimeters as Uint16Array. Compact (2 bytes/sample vs 4),
 *   0–65535 mm range (0–65.535 m). Matches real LiDAR hardware output
 *   (e.g., Velodyne, SICK). Use for storage, transport, or when
 *   interfacing with robotics middleware expecting integer mm.
 */
export type LidarEncoding = "float32" | "uint16";

/**
 * Unit of depth values, determined by the encoding.
 *
 * These are fixed hardware conventions — they don't change based
 * on the simulation's scene units:
 * - `"mm"` for `uint16` encoding (matches Velodyne, SICK, etc.)
 * - `"m"` for `float32` encoding (standard SI)
 *
 * The adapter handles conversion from scene units to these hardware
 * units internally using the `ISimSpace.context.units.length`.
 */
export type LidarUnit = "m" | "mm";

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

    /**
     * Maximum lidar range in meters.
     * Depth values beyond this distance are reported as 0 (no return),
     * matching real lidar behavior for sky or out-of-range hits. Defaults to 100.
     */
    maxRange?: number;

    /**
     * Depth encoding format.
     *
     * - `"float32"` (default): meters as Float32Array. Full precision.
     *   Best for simulation, training pipelines, and internal processing.
     *
     * - `"uint16"`: millimeters as Uint16Array. Compact storage (half the
     *   memory), 0–65535 mm range. Matches real LiDAR hardware output.
     *   Values beyond 65.535 m are clamped to 65535 mm.
     *
     * Defaults to `"float32"`.
     */
    encoding?: LidarEncoding;
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

    /** Angular resolution in degrees per column. */
    angularResolution: number;

    /** Maximum lidar range in meters. */
    maxRange: number;

    /**
     * Encoding format of the depth data.
     * Determines the typed array type and unit.
     */
    encoding: LidarEncoding;

    /**
     * Unit of depth values in the data array.
     * - `"m"` when encoding is `"float32"`.
     * - `"mm"` when encoding is `"uint16"`.
     */
    unit: LidarUnit;
}

/**
 * Result of a lidar-style depth scan.
 *
 * Contains raw depth values as a typed array — no base64, no transport
 * encoding. Serialization (base64, protobuf, etc.) is the responsibility
 * of protocol adapters (MCP, WebSocket, etc.), not the sensor data model.
 *
 * Grid layout: row-major, `data[row * columns + col]`.
 * - Rows = vertical beams (0 = top beam, beams−1 = bottom beam)
 * - Columns = horizontal samples (left to right across the FOV)
 * - 0 = no return (out of range).
 *
 * The typed array type depends on the encoding:
 * - `"float32"` → `Float32Array`, values in meters.
 * - `"uint16"` → `Uint16Array`, values in millimeters (0–65535).
 */
export interface ILidarScanResult {
    /**
     * Depth values as a typed array.
     * Length = beams × columns. Row-major: `data[row * columns + col]`.
     * 0 = no return (depth beyond maxRange or sky).
     *
     * - `Float32Array` when `metadata.encoding === "float32"` (values in meters).
     * - `Uint16Array` when `metadata.encoding === "uint16"` (values in millimeters).
     */
    data: Float32Array | Uint16Array;

    /** Scan metadata describing grid dimensions, planes, FOV, encoding, and unit. */
    metadata: ILidarScanMetadata;
}

export interface ILidarEvent extends IRecord<ILidarScanResult> {}

export interface ILidarNode extends ISensorNode, ISensorReadable<ILidarScanResult>, ISensorEventEmitter<ILidarEvent> {
    scan(options: ILidarScanOptions): ILidarScanResult;
}
