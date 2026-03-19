import { GraphNode } from "@spiky-panda/core";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { IAccelerometerNode, IGyroNode, IIMU6Node } from "@dev/core/perception";
import { ISimSpace } from "@dev/core/simulation";
import { generateId } from "@dev/core/utils";
import { BabylonAccelerometerAdapter } from "./babylon.accelerometer.adapter";
import { BabylonGyroscopeAdapter } from "./babylon.gyroscope.adapter";

/**
 * Babylon.js adapter for a 6-DOF IMU (accelerometer + gyroscope).
 *
 * Composite sensor that owns a `BabylonAccelerometerAdapter` and a
 * `BabylonGyroscopeAdapter`, both tracking the same `TransformNode`.
 * Propagates simulation lifecycle callbacks to both children.
 *
 * Usage:
 * ```typescript
 * const imu = new BabylonIMUAdapter(robotMesh);
 * // imu.acc.sensorRead() → ICartesian3 (ax, ay, az) in m/s²
 * // imu.gyro.sensorRead() → ICartesian3 (gx, gy, gz) in rad/s
 * ```
 */
export class BabylonIMUAdapter extends GraphNode implements IIMU6Node {
    /** 3-axis accelerometer sub-sensor. */
    public readonly acc: IAccelerometerNode;

    /** 3-axis gyroscope sub-sensor. */
    public readonly gyro: IGyroNode;

    /**
     * @param node  The Babylon.js TransformNode that both the accelerometer
     *              and gyroscope will track for position/rotation deltas.
     */
    public constructor(node: TransformNode) {
        super();
        this.id = generateId("imu6");
        this.acc = new BabylonAccelerometerAdapter(node);
        this.gyro = new BabylonGyroscopeAdapter(node);
    }

    // -- ISimNode lifecycle (propagate to children) --

    public onTick(dtMs: number): void {
        (this.acc as BabylonAccelerometerAdapter).onTick(dtMs);
        (this.gyro as BabylonGyroscopeAdapter).onTick(dtMs);
    }

    public onAdded(space: ISimSpace): void {
        (this.acc as BabylonAccelerometerAdapter).onAdded(space);
        (this.gyro as BabylonGyroscopeAdapter).onAdded(space);
    }

    public onRemoved(space: ISimSpace): void {
        (this.acc as BabylonAccelerometerAdapter).onRemoved(space);
        (this.gyro as BabylonGyroscopeAdapter).onRemoved(space);
    }

    public override dispose(): void {
        (this.acc as BabylonAccelerometerAdapter).dispose();
        (this.gyro as BabylonGyroscopeAdapter).dispose();
        super.dispose();
    }
}
