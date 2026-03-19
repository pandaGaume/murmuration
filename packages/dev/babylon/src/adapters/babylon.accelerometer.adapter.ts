import { Cartesian3, GraphNode, ICartesian3, IDisposable } from "@spiky-panda/core";
import { TransformNode, Vector3 } from "@babylonjs/core";
import { IAccelerometerEvent, IAccelerometerNode, ISensor } from "@dev/core/perception";
import { ISimSpace } from "@dev/core/simulation";
import { generateId } from "@dev/core/utils";

import { toCartesian3 } from "../utils";

/**
 * Babylon.js adapter for accelerometer sensor.
 *
 * Derives linear acceleration from a `TransformNode`'s world position
 * by computing the second derivative of position over time:
 *
 *   velocity     = (position − prevPosition) / dt
 *   acceleration = (velocity − prevVelocity) / dt
 *
 * This requires two warm-up ticks before producing valid readings
 * (first tick captures position baseline, second captures velocity baseline).
 *
 * Output is in m/s² in world space, matching the Babylon scene's coordinate
 * system (Y-up by default).
 */
export class BabylonAccelerometerAdapter extends GraphNode implements IAccelerometerNode {
    private _node: TransformNode;
    private _prevPosition: Vector3 | null = null;
    private _prevVelocity: Vector3 | null = null;
    private _lastReading: ICartesian3 = Cartesian3.Zero();
    private _listeners: Array<(src: ISensor, data: IAccelerometerEvent[]) => void> = [];

    /**
     * @param node  The Babylon.js TransformNode whose world position
     *              is used to derive acceleration.
     */
    public constructor(node: TransformNode) {
        super();
        this.id = generateId("accel");
        this._node = node;
    }

    // -- ISensorReadable<ICartesian3> --

    public sensorRead(): ICartesian3 {
        return this._lastReading;
    }

    // -- ISensorEventEmitter<IAccelerometerEvent> --

    public onSensorEvent(callback: (src: ISensor, data: IAccelerometerEvent[]) => void): IDisposable {
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

        const currentPos = this._node.absolutePosition.clone();

        // First tick: capture position baseline.
        if (this._prevPosition === null) {
            this._prevPosition = currentPos;
            return;
        }

        // Compute velocity (first derivative of position).
        const velocity = currentPos.subtract(this._prevPosition).scale(1 / dtSec);
        this._prevPosition = currentPos;

        // Second tick: capture velocity baseline.
        if (this._prevVelocity === null) {
            this._prevVelocity = velocity;
            return;
        }

        // Compute acceleration (second derivative of position).
        const acceleration = velocity.subtract(this._prevVelocity).scale(1 / dtSec);
        this._prevVelocity = velocity;

        this._lastReading = toCartesian3(acceleration);

        // Emit to subscribers.
        if (this._listeners.length > 0) {
            const event: IAccelerometerEvent = {
                id: this.id,
                series: [
                    {
                        measurement: { schema: "acceleration.linear" },
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
        // Reset warm-up state when added to a new simulation.
        this._prevPosition = null;
        this._prevVelocity = null;
    }

    public onRemoved(_space: ISimSpace): void {
        this._listeners.length = 0;
    }

    public override dispose(): void {
        super.dispose();
        this._listeners.length = 0;
    }
}
