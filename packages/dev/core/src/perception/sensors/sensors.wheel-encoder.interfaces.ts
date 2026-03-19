import { IRecord } from "@dev/core/telemetry";
import { ISensorEventEmitter, ISensorNode, ISensorReadable } from "./sensors.interfaces";

// ---------------------------------------------------------------------------
// Per-wheel layer
// ---------------------------------------------------------------------------

/**
 * Static properties of a wheel encoder.
 */
export interface IWheelEncoderConfig {
    /** Encoder resolution in ticks per full revolution (e.g. 360, 1024, 4096). */
    ticksPerRevolution: number;

    /** Wheel radius in meters — used to derive linear distance from ticks. */
    wheelRadius: number;
}

/**
 * Wheel rotation direction.
 *  1 = forward, -1 = reverse, 0 = stopped.
 */
export type WheelDirection = 1 | -1 | 0;

/**
 * Instantaneous reading from a single wheel encoder.
 */
export interface IWheelEncoderData {
    /** Cumulative tick count since last reset. Negative values indicate reverse travel. */
    ticks: number;

    /** Angular velocity of the wheel in rad/s. */
    angularVelocity: number;

    /** Linear velocity in m/s (angularVelocity * wheelRadius). */
    linearVelocity: number;

    /** Rotation direction. */
    direction: WheelDirection;

    /**
     * Slip ratio: 0.0 (no slip) to 1.0 (full slip).
     * `null` when slip detection is unavailable or not yet computed.
     */
    slipRatio: number | null;

    /** Convenience flag — true when slipRatio exceeds the configured threshold. */
    slipping: boolean;
}

export interface IWheelEncoderEvent extends IRecord<IWheelEncoderData> {}

export interface IWheelEncoderNode extends ISensorNode, ISensorReadable<IWheelEncoderData>, ISensorEventEmitter<IWheelEncoderEvent> {
    /** Static configuration of this encoder. */
    config: IWheelEncoderConfig;

    /** Zero the cumulative tick counter. */
    resetTicks(): void;
}

// ---------------------------------------------------------------------------
// Multi-wheel odometry layer
// ---------------------------------------------------------------------------

/**
 * Associates a labelled wheel position with its encoder node.
 */
export interface IWheelPosition {
    /** Human-readable identifier (e.g. "front_left", "rear_right"). */
    label: string;

    /** Reference to the encoder node for this wheel. */
    encoder: IWheelEncoderNode;
}

/**
 * Fused pose estimate derived from multiple wheel encoders.
 */
export interface IOdometryEstimate {
    /** Position x in meters (local frame). */
    x: number;

    /** Position y in meters (local frame). */
    y: number;

    /** Heading in radians. */
    theta: number;

    /** Forward linear velocity in m/s. */
    linearVelocity: number;

    /** Turning rate in rad/s. */
    angularVelocity: number;

    /**
     * `false` when any contributing wheel reports a slip ratio
     * above the configured threshold — downstream consumers should
     * down-weight or discard this estimate.
     */
    reliable: boolean;
}

export interface IOdometryEvent extends IRecord<IOdometryEstimate> {}

export interface IDifferentialOdometryNode extends ISensorNode, ISensorReadable<IOdometryEstimate>, ISensorEventEmitter<IOdometryEvent> {
    /** Enrolled wheels with their positions. */
    wheels: IWheelPosition[];

    /** Distance between left and right wheels in meters. */
    wheelBase: number;

    /** Slip ratio above which the odometry estimate is marked as unreliable. */
    slipThreshold: number;

    /** Zero the pose estimate (x, y, theta back to origin). */
    reset(): void;
}
