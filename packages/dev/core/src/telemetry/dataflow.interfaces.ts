/**
 * Provides a monotonic sequence index for ordering data points.
 *
 * Used by replay systems and loggers to reconstruct the original
 * emission order independently of wall-clock timestamps (which may
 * jitter or be unavailable in offline / batch scenarios).
 */
export interface IIndexed {
    /** Zero-based monotonic index within the producing stream. */
    index?: number;
}

/**
 * Provides a wall-clock timestamp for a data point.
 *
 * Used by time-series storage, charting, and real-time consumers
 * to correlate samples across different sensor streams.
 */
export interface ITimed {
    /** Wall-clock timestamp when the measurement was taken (or received). */
    When?: Date;
}

/**
 * A data point that can be placed in both index-order and time-order.
 *
 * Combining `IIndexed` and `ITimed` gives consumers two independent
 * ordering axes:
 * - **`index`** — for lossless replay at the original emission rate.
 * - **`When`** — for calendar alignment and cross-sensor correlation.
 *
 * Both fields are optional: a sensor that only provides timestamps
 * (e.g., GPS) can omit the index, and a high-frequency sensor running
 * in a tight tick loop can omit the timestamp and rely on the index.
 */
export interface ISequenceable extends ITimed, IIndexed {}
