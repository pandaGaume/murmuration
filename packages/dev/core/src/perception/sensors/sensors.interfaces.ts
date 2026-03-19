import { IDisposable, IIDentifiable } from "@spiky-panda/core";
import { ISimNode } from "@dev/core/simulation";
import { IRecord } from "@dev/core/telemetry";

/**
 * Base interface for all sensors in the perception layer.
 *
 * A sensor is an identifiable, disposable resource that can be looked up
 * by its unique ID and cleaned up when no longer needed. Every concrete
 * sensor type (IMU, lidar, wheel encoder, …) extends this contract.
 *
 * @extends IIDentifiable  Provides a unique `id` for sensor lookup / routing.
 * @extends IDisposable    Allows deterministic cleanup of hardware handles,
 *                         event subscriptions, or GPU resources.
 */
export interface ISensor extends IIDentifiable, IDisposable {}

/**
 * Capability mixin: synchronous, pull-based sensor reading.
 *
 * Attach this to any sensor that can return its latest value on demand
 * (e.g., read the current accelerometer vector, read the last lidar scan).
 * Consumers call `sensorRead()` inside the simulation tick loop to get
 * the most recent measurement without waiting for an event.
 *
 * @typeParam T  The value type returned by this sensor
 *               (e.g., `ICartesian3` for an accelerometer,
 *                `ILidarScanResult` for a lidar node).
 */
export interface ISensorReadable<T> {
    /** Return the latest sensor measurement. */
    sensorRead(): T;
}

/**
 * Capability mixin: synchronous, push-based sensor writing.
 *
 * Attach this to any sensor that can receive commands or calibration
 * values from the outside (e.g., setting a gyro bias offset, writing
 * a motor setpoint to a servo sensor).
 *
 * @typeParam T  The value type accepted by this sensor.
 */
export interface ISensorWritable<T> {
    /** Push a value into the sensor (command, calibration, setpoint…). */
    sensorWrite(value: T): void;
}

/**
 * Capability mixin: event-driven sensor data emission.
 *
 * Sensors that produce asynchronous or batched data expose this interface
 * so consumers can subscribe to new readings without polling.
 * The callback receives the source sensor (for multi-sensor setups)
 * and an array of records (to support batch / burst modes).
 *
 * The returned `IDisposable` unsubscribes the listener when disposed,
 * preventing leaks in dynamic sensor topologies.
 *
 * @typeParam TEvent  The record type emitted by this sensor.
 *                    Must extend `IRecord` so every event carries
 *                    source identification and time-series metadata.
 */
export interface ISensorEventEmitter<TEvent extends IRecord> {
    /**
     * Subscribe to sensor events.
     * @param callback  Invoked each time the sensor produces new data.
     *                  `src` is the emitting sensor; `data` is one or more records.
     * @returns         A disposable handle — call `.dispose()` to unsubscribe.
     */
    onSensorEvent(callback: (src: ISensor, data: TEvent[]) => void): IDisposable;
}

/**
 * A sensor that participates in the simulation graph.
 *
 * Combines the sensor identity/lifecycle (`ISensor`) with the simulation
 * node lifecycle (`ISimNode`), so the sensor receives `onTick(dtMs)` calls
 * and can be added/removed from a `ISimSpace`. This is the base type for
 * every concrete sensor node (IMU, lidar, wheel encoder, navigator…).
 *
 * @extends ISensor   Identity + disposable cleanup.
 * @extends ISimNode  Simulation tick + graph attachment lifecycle.
 */
export interface ISensorNode extends ISensor, ISimNode {}
