import { Cartesian3, GraphNode, ICartesian3, IDisposable } from "@spiky-panda/core";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { IGyroEvent, IGyroNode, ISensor } from "@dev/core/perception";
import { ISimSpace } from "@dev/core/simulation";
import { generateId } from "@dev/core/utils";
import { angularVelocityFromQuaternions, toCartesian3 } from "../utils";

/**
 * Babylon.js adapter for gyroscope sensor.
 *
 * Derives angular velocity from a `TransformNode`'s world rotation
 * quaternion by computing the delta quaternion between consecutive
 * ticks and converting to an axis-angle angular velocity vector.
 *
 * Output is in rad/s in world space.
 *
 * If the tracked node uses Euler angles (`rotation`) instead of
 * `rotationQuaternion`, the adapter converts to quaternion internally.
 */
export class BabylonGyroscopeAdapter extends GraphNode implements IGyroNode {
    private _node: TransformNode;
    private _prevQuaternion: Quaternion | null = null;
    private _lastReading: ICartesian3 = Cartesian3.Zero();
    private _listeners: Array<(src: ISensor, data: IGyroEvent[]) => void> = [];

    /**
     * @param node  The Babylon.js TransformNode whose world rotation
     *              is used to derive angular velocity.
     */
    public constructor(node: TransformNode) {
        super();
        this.id = generateId("gyro");
        this._node = node;
    }

    // -- ISensorReadable<ICartesian3> --

    public sensorRead(): ICartesian3 {
        return this._lastReading;
    }

    // -- ISensorEventEmitter<IGyroEvent> --

    public onSensorEvent(callback: (src: ISensor, data: IGyroEvent[]) => void): IDisposable {
        this._listeners.push(callback);
        return {
            dispose: () => {
                const idx = this._listeners.indexOf(callback);
                if (idx >= 0) this._listeners.splice(idx, 1);
            },
        };
    }

    // -- ISimNode lifecycle --

    public onTick(dtMs: number): void {
        const dtSec = dtMs / 1000;
        if (dtSec <= 0) return;

        // Read current world rotation as quaternion.
        const currentQ = this._getWorldQuaternion();

        // First tick: capture baseline.
        if (this._prevQuaternion === null) {
            this._prevQuaternion = currentQ.clone();
            return;
        }

        // Compute angular velocity from quaternion delta.
        this._lastReading = toCartesian3(angularVelocityFromQuaternions(this._prevQuaternion, currentQ, dtSec));
        this._prevQuaternion = currentQ.clone();

        // Emit to subscribers.
        if (this._listeners.length > 0) {
            const event: IGyroEvent = {
                id: this.id,
                series: [
                    {
                        measurement: { schema: "velocity.angular" },
                        samples: [{ value: this._lastReading, quality: 192 }],
                    },
                ],
            };
            for (const listener of this._listeners) {
                listener(this, [event]);
            }
        }
    }

    public onAdded(_space: ISimSpace): void {
        this._prevQuaternion = null;
    }

    public onRemoved(_space: ISimSpace): void {
        this._listeners.length = 0;
    }

    public override dispose(): void {
        super.dispose();
        this._listeners.length = 0;
    }

    // -- Private --

    /**
     * Read the node's absolute world rotation as a quaternion.
     * Falls back to converting Euler angles if `rotationQuaternion` is null
     * (Babylon uses Euler by default until a quaternion is explicitly set).
     */
    private _getWorldQuaternion(): Quaternion {
        if (this._node.absoluteRotationQuaternion) {
            return this._node.absoluteRotationQuaternion;
        }
        // Fallback: convert Euler rotation to quaternion.
        const r = this._node.rotation;
        return Quaternion.FromEulerAngles(r.x, r.y, r.z);
    }
}
