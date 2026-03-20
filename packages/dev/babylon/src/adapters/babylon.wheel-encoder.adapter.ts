import { IDisposable } from "@spiky-panda/core";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ISensor, IWheelEncoderConfig, IWheelEncoderData, IWheelEncoderEvent, IWheelEncoderNode, WheelDirection } from "@dev/core/perception";
import { ISimSpace, SimTreeNode } from "@dev/core/simulation";
import { generateId } from "@dev/core/utils";

/**
 * Axis around which the wheel spins.
 * Must match the wheel mesh's local rotation convention.
 */
export type SpinAxis = "x" | "y" | "z";

/**
 * Options for the Babylon wheel encoder adapter.
 */
export interface IBabylonWheelEncoderOptions {
    /**
     * Local axis around which the wheel mesh rotates.
     * Default: `"x"` (common for wheels oriented along the X axis).
     */
    spinAxis?: SpinAxis;

    /**
     * If provided, enables slip detection by comparing the wheel's
     * surface speed against the body's linear velocity projected
     * onto the wheel's forward direction.
     *
     * This should be the physics body of the vehicle chassis (not the wheel
     * itself), so we can compare "what the wheel thinks" vs "what the body
     * actually does".
     */
    chassisForwardProvider?: () => { linearVelocity: Vector3; forward: Vector3 };
}

/**
 * Babylon.js adapter for a wheel encoder sensor.
 *
 * Derives encoder ticks, angular velocity, linear velocity, direction,
 * and slip ratio from a Babylon mesh's rotation around a configurable
 * spin axis.
 *
 * **Tick computation**: reads the mesh's local rotation on the spin axis
 * each frame, computes the angular delta (handling 2π wrapping), and
 * converts to encoder ticks via `ticksPerRevolution`.
 *
 * **Slip detection**: if a `chassisForwardProvider` is supplied, the
 * adapter compares the wheel's surface speed (`angularVelocity × wheelRadius`)
 * against the chassis's forward ground speed. The slip ratio is:
 *
 *   slipRatio = |surfaceSpeed − groundSpeed| / max(surfaceSpeed, groundSpeed, ε)
 *
 * This matches the standard tire slip formula used in vehicle dynamics.
 */
export class BabylonWheelEncoderAdapter extends SimTreeNode implements IWheelEncoderNode {
    /** Static encoder configuration. */
    public config: IWheelEncoderConfig;

    private _wheelMesh: AbstractMesh;
    private _spinAxis: SpinAxis;
    private _chassisForwardProvider: IBabylonWheelEncoderOptions["chassisForwardProvider"];

    private _cumulativeTicks = 0;
    private _prevAngle: number | null = null;
    private _lastReading: IWheelEncoderData = {
        ticks: 0,
        angularVelocity: 0,
        linearVelocity: 0,
        direction: 0,
        slipRatio: null,
        slipping: false,
    };

    private _listeners: Array<(src: ISensor, data: IWheelEncoderEvent[]) => void> = [];

    /**
     * @param wheelMesh  The Babylon mesh representing the wheel.
     * @param config     Encoder resolution and wheel geometry.
     * @param options    Spin axis and optional chassis provider for slip detection.
     */
    public constructor(wheelMesh: AbstractMesh, config: IWheelEncoderConfig, options?: IBabylonWheelEncoderOptions) {
        super();
        this.id = generateId("wheel-enc");
        this._wheelMesh = wheelMesh;
        this.config = config;
        this._spinAxis = options?.spinAxis ?? "x";
        this._chassisForwardProvider = options?.chassisForwardProvider;
    }

    // -- ISensorReadable<IWheelEncoderData> --

    public sensorRead(): IWheelEncoderData {
        return this._lastReading;
    }

    // -- ISensorEventEmitter<IWheelEncoderEvent> --

    public onSensorEvent(callback: (src: ISensor, data: IWheelEncoderEvent[]) => void): IDisposable {
        this._listeners.push(callback);
        return {
            dispose: () => {
                const idx = this._listeners.indexOf(callback);
                if (idx >= 0) this._listeners.splice(idx, 1);
            },
        };
    }

    // -- IWheelEncoderNode --

    public resetTicks(): void {
        this._cumulativeTicks = 0;
    }

    // -- ISimNode lifecycle --

    protected override onSelfTick(dtMs: number): void {
        const dtSec = dtMs / 1000;
        if (dtSec <= 0) return;

        // Read current rotation on the spin axis.
        const currentAngle = this._readSpinAngle();

        // First tick: capture baseline.
        if (this._prevAngle === null) {
            this._prevAngle = currentAngle;
            return;
        }

        // Compute angular delta, handling 2π wrapping.
        let deltaAngle = currentAngle - this._prevAngle;
        if (deltaAngle > Math.PI) deltaAngle -= 2 * Math.PI;
        if (deltaAngle < -Math.PI) deltaAngle += 2 * Math.PI;
        this._prevAngle = currentAngle;

        // Convert to ticks.
        const deltaTicks = (deltaAngle / (2 * Math.PI)) * this.config.ticksPerRevolution;
        this._cumulativeTicks += deltaTicks;

        // Angular and linear velocity.
        const angularVelocity = deltaAngle / dtSec;
        const linearVelocity = angularVelocity * this.config.wheelRadius;

        // Direction.
        const direction: WheelDirection = deltaTicks > 0.001 ? 1 : deltaTicks < -0.001 ? -1 : 0;

        // Slip detection.
        let slipRatio: number | null = null;
        if (this._chassisForwardProvider) {
            const chassis = this._chassisForwardProvider();
            // Project chassis linear velocity onto its forward direction.
            const groundSpeed = Math.abs(Vector3.Dot(chassis.linearVelocity, chassis.forward));
            const surfaceSpeed = Math.abs(linearVelocity);
            const maxSpeed = Math.max(surfaceSpeed, groundSpeed, 0.01);
            slipRatio = Math.abs(surfaceSpeed - groundSpeed) / maxSpeed;
        }

        this._lastReading = {
            ticks: Math.round(this._cumulativeTicks),
            angularVelocity,
            linearVelocity,
            direction,
            slipRatio,
            slipping: slipRatio !== null && slipRatio >= 0.3,
        };

        // Emit to subscribers.
        if (this._listeners.length > 0) {
            const event: IWheelEncoderEvent = {
                id: this.id,
                series: [
                    {
                        measurement: { schema: "encoder.wheel" },
                        samples: [{ value: this._lastReading, quality: 192 }],
                    },
                ],
            };
            for (const listener of this._listeners) {
                listener(this, [event]);
            }
        }
    }

    protected override onSelfAdded(_space: ISimSpace): void {
        this._prevAngle = null;
    }

    protected override onSelfRemoved(_space: ISimSpace): void {
        this._listeners.length = 0;
    }

    public override dispose(): void {
        super.dispose();
        this._listeners.length = 0;
    }

    // -- Private --

    /** Read the wheel mesh's local rotation on the configured spin axis. */
    private _readSpinAngle(): number {
        const r = this._wheelMesh.rotation;
        switch (this._spinAxis) {
            case "x":
                return r.x;
            case "y":
                return r.y;
            case "z":
                return r.z;
        }
    }
}
