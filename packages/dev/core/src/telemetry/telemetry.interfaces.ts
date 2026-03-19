import { ISequenceable } from "./dataflow.interfaces";

/**
 * OPC-UA inspired quality level for sensor measurements.
 *
 * Every sample carries a quality flag so downstream consumers
 * (state estimators, loggers, MCP tools) can decide how much to
 * trust a reading. The three-tier scheme mirrors the OPC Unified
 * Architecture status code model:
 *
 * - **Good (192+)**: the value is usable as-is.
 * - **Uncertain (64–191)**: the value may be stale or degraded —
 *   use with caution (e.g., apply larger Kalman gain).
 * - **Bad (0–63)**: the value should not be used for control;
 *   fall back to a safe default or raise an alert.
 *
 * Numeric values are chosen to match OPC-UA status code sub-ranges
 * so existing OPC-UA tooling can interpret them directly.
 */
export enum QualityLevel {
    // ---- GOOD (192) ----

    /** Value is fresh and reliable. */
    Good = 192, // 0xC0

    /** Value was overridden by a local operator (still good). */
    GoodLocalOverride = 216, // 0xD8

    // ---- UNCERTAIN (64) ----

    /** Quality is uncertain for an unspecified reason. */
    Uncertain = 64, // 0x40

    /** Sensor data is stale — last known usable value is returned. */
    UncertainLastUsableValue = 68, // 0x44

    /** Sensor is operating outside its calibrated accuracy band. */
    UncertainSensorNotAccurate = 80, // 0x50

    /** Measured value exceeds the engineering unit range. */
    UncertainEngineeringUnitsExceeded = 84, // 0x54

    /** Value is below normal operating threshold. */
    UncertainSubNormal = 88, // 0x58

    // ---- BAD (0) ----

    /** Generic bad quality — do not use for control. */
    Bad = 0, // 0x00

    /** Sensor configuration is invalid. */
    BadConfigurationError = 4, // 0x04

    /** Communication link to the sensor is down. */
    BadNotConnected = 8, // 0x08

    /** Hardware device failure detected. */
    BadDeviceFailure = 12, // 0x0C

    /** Sensor element itself has failed. */
    BadSensorFailure = 16, // 0x10

    /** Last known value is retained but the sensor is unreachable. */
    BadLastKnownValue = 20, // 0x14

    /** Communication failure (timeout, CRC error, …). */
    BadCommFailure = 24, // 0x18

    /** Sensor is administratively taken out of service. */
    BadOutOfService = 28, // 0x1C

    /** Sensor is initializing and has not yet produced a value. */
    BadWaitingForInitialData = 32, // 0x20
}

/**
 * Mixin providing a primary and optional secondary source identifier.
 *
 * Used by `IRecord` to tag every data record with the sensor (or system)
 * that produced it. The `subId` allows disambiguation when a single
 * physical sensor produces multiple logical streams (e.g., an IMU
 * with `id = "imu-01"` and `subId = "acc"` or `"gyro"`).
 */
export interface IHasSourceIdentifier {
    /** Primary source identifier (e.g., sensor ID, node name). */
    id: string;

    /** Optional secondary identifier for sub-streams within a source. */
    subId?: string;
}

/**
 * A telemetry record: one or more time-series produced by a single source.
 *
 * This is the standard envelope for all sensor data flowing through the
 * telemetry pipeline. Events emitted by `ISensorEventEmitter` are typed
 * as `IRecord<T>`, where `T` is the domain value (e.g., `ICartesian3`
 * for an accelerometer, `ILidarScanResult` for a lidar node).
 *
 * @typeParam T  The domain value type carried by each sample in the series.
 */
export interface IRecord<T = unknown> extends IHasSourceIdentifier {
    /** One or more time-series contained in this record. */
    series: ITimeSerie<T>[];
}

/**
 * Describes what a time-series measures.
 *
 * The `schema` string identifies the measurement kind so consumers
 * can select, filter, or route series without inspecting sample values
 * (e.g., `"acceleration.linear"`, `"depth.lidar"`, `"odometry.pose"`).
 */
export interface IMeasurement {
    /** Schema identifier for this measurement type. */
    schema: string;
}

/**
 * Mixin that tags an entity with a measurement descriptor.
 */
export interface IHasMeasurementIdentifier {
    /** Measurement metadata describing what this entity measures. */
    measurement: IMeasurement;
}

/**
 * An ordered sequence of samples for a single measurement.
 *
 * A time-series belongs to exactly one `IRecord` (source) and carries
 * a `measurement` descriptor so consumers know the physical quantity.
 * Samples are ordered by their `ISequenceable` index/timestamp.
 *
 * @typeParam T  The domain value type of each sample.
 */
export interface ITimeSerie<T> extends IHasMeasurementIdentifier {
    /** Ordered samples in this series. */
    samples: ISample<T>[];
}

/**
 * A single measurement point: value + quality + sequence metadata.
 *
 * Each sample carries:
 * - **`value`**: the domain measurement (vector, depth grid, pose, …).
 * - **`quality`**: an OPC-UA style quality flag indicating trustworthiness.
 * - **`When` / `index`** (from `ISequenceable`): timestamp and/or
 *   monotonic index for ordering and replay.
 *
 * @typeParam T  The domain value type.
 */
export interface ISample<T> extends ISequenceable {
    /** The measured value. */
    value: T;

    /** Quality level of this measurement. */
    quality: QualityLevel;
}
