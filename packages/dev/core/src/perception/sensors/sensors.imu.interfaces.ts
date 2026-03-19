import { ICartesian3 } from "@spiky-panda/core";
import { IRecord } from "@dev/core/telemetry";
import { ISensorEventEmitter, ISensorNode, ISensorReadable } from "./sensors.interfaces";

/**
 * Event record emitted by an accelerometer sensor.
 *
 * Each event wraps an `ICartesian3` measurement (ax, ay, az) in the
 * telemetry `IRecord` envelope, providing source identification and
 * time-series metadata for downstream logging / replay.
 */
export interface IAccelerometerEvent extends IRecord<ICartesian3> {}

/**
 * Accelerometer sensor node.
 *
 * Measures linear acceleration along three orthogonal axes (x, y, z)
 * expressed in m/s². Typical use: gravity detection, tilt estimation,
 * vibration monitoring, and as one half of a 6-DOF IMU.
 *
 * - **Pull** via `sensorRead()` → latest `ICartesian3` (ax, ay, az).
 * - **Push** via `onSensorEvent()` → batched `IAccelerometerEvent` records.
 *
 * @extends ISensorNode                          Simulation-aware sensor lifecycle.
 * @extends ISensorReadable<ICartesian3>         Synchronous pull reading.
 * @extends ISensorEventEmitter<IAccelerometerEvent>  Asynchronous event stream.
 */
export interface IAccelerometerNode extends ISensorNode, ISensorReadable<ICartesian3>, ISensorEventEmitter<IAccelerometerEvent> {}

/**
 * Event record emitted by a gyroscope sensor.
 *
 * Wraps an `ICartesian3` measurement (gx, gy, gz) — angular velocity
 * in rad/s around each axis — in the telemetry `IRecord` envelope.
 */
export interface IGyroEvent extends IRecord<ICartesian3> {}

/**
 * Gyroscope sensor node.
 *
 * Measures angular velocity around three orthogonal axes (x, y, z)
 * expressed in rad/s. Typical use: heading estimation, rotational
 * stabilization, and as the other half of a 6-DOF IMU.
 *
 * - **Pull** via `sensorRead()` → latest `ICartesian3` (gx, gy, gz).
 * - **Push** via `onSensorEvent()` → batched `IGyroEvent` records.
 *
 * @extends ISensorNode                          Simulation-aware sensor lifecycle.
 * @extends ISensorReadable<ICartesian3>         Synchronous pull reading.
 * @extends ISensorEventEmitter<IAccelerometerEvent>  Asynchronous event stream.
 */
export interface IGyroNode extends ISensorNode, ISensorReadable<ICartesian3>, ISensorEventEmitter<IAccelerometerEvent> {}

/**
 * 6-DOF Inertial Measurement Unit (IMU).
 *
 * Combines a 3-axis accelerometer and a 3-axis gyroscope into a single
 * composite sensor node. Together they provide the six degrees of freedom
 * needed for dead-reckoning orientation estimation:
 *
 * - `acc` → linear acceleration (ax, ay, az) in m/s²
 * - `gyro` → angular velocity (gx, gy, gz) in rad/s
 *
 * A typical consumer fuses both streams through a complementary or
 * Kalman filter to obtain a stable attitude quaternion.
 *
 * @extends ISensorNode  Participates in the simulation graph; `onTick()`
 *                       propagates to both child sensors.
 */
export interface IIMU6Node extends ISensorNode {
    /** 3-axis accelerometer sub-sensor. */
    acc: IAccelerometerNode;

    /** 3-axis gyroscope sub-sensor. */
    gyro: IGyroNode;
}
