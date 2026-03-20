import { IDisposable } from "@spiky-panda/core";
import { ISimSpace, SimTreeNode } from "@dev/core/simulation";
import { ISensor } from "./sensors.interfaces";
import { generateId } from "@dev/core/utils";
import { IDifferentialOdometryNode, IOdometryEstimate, IOdometryEvent, IWheelEncoderData, IWheelPosition } from "./sensors.wheel-encoder.interfaces";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Per-wheel state tracked between ticks for delta computation.
 */
interface WheelTickState {
    /** Reference to the enrolled wheel position. */
    wheel: IWheelPosition;

    /** Tick count captured on the previous frame (`null` = first tick). */
    prevTicks: number | null;

    /** Pre-computed meters per encoder tick (cached from config). */
    metersPerTick: number;
}

/**
 * Aggregated result for one side (left or right) after reading
 * all enrolled wheels, filtering slipping ones, and averaging.
 */
interface SideAggregate {
    /** Averaged linear displacement in meters for this side. */
    displacement: number;

    /** Number of wheels that contributed (were not slipping). */
    contributing: number;

    /** Total number of wheels on this side. */
    total: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Differential-drive odometry with N-wheels-per-side support.
 *
 * Computes (x, y, theta) from any number of wheel encoders grouped
 * into a "left" side and a "right" side. This covers:
 *
 * - **2-wheel** differential drive (1 left + 1 right)
 * - **4-wheel** skid-steer (2 left + 2 right)
 * - **6-wheel** rover (3 left + 3 right, e.g. rocker-bogie)
 *
 * ### Per-side aggregation with slip filtering
 *
 * On each tick, for each side:
 *   1. Read all enrolled encoders and compute per-wheel displacement.
 *   2. **Discard** any wheel whose `slipRatio ≥ slipThreshold`.
 *   3. **Average** the remaining wheels' displacements.
 *   4. If **all** wheels on a side are slipping, the side uses the
 *      raw average anyway but the estimate is flagged `reliable = false`.
 *
 * This way a single slipping wheel (e.g., front-left climbing a rock)
 * is filtered out while the other two left-side wheels compensate.
 *
 * ### Kinematic integration (midpoint arc)
 *
 * Once we have a single left/right displacement, the standard
 * differential-drive equations apply:
 *
 * ```
 * dCenter = (dLeft + dRight) / 2
 * dTheta  = (dRight − dLeft) / wheelBase
 *
 * x     += dCenter × cos(theta + dTheta / 2)
 * y     += dCenter × sin(theta + dTheta / 2)
 * theta += dTheta
 * ```
 *
 * Midpoint integration (`theta + dTheta/2`) treats each step as a
 * circular arc, significantly reducing drift on curved paths.
 *
 * ### Wheel labelling convention
 *
 * Wheels are assigned to a side by their `label` prefix:
 * - **Left side**: any label starting with `"left"` (e.g., `"left"`,
 *   `"left_front"`, `"left_middle"`, `"left_rear"`).
 * - **Right side**: any label starting with `"right"`.
 *
 * At least one wheel per side is required.
 *
 * ### Assumptions
 *
 * - Skid-steer or differential drive (no explicit steering angle).
 * - All wheels on the same side are coaxial (same effective track).
 * - The robot moves on a 2D plane (no pitch/roll compensation).
 */
export class DifferentialOdometry extends SimTreeNode implements IDifferentialOdometryNode {
    /** All enrolled wheels. */
    public wheels: IWheelPosition[];

    /** Distance between left and right wheel tracks in meters. */
    public wheelBase: number;

    /** Slip ratio above which a wheel is excluded from averaging. */
    public slipThreshold: number;

    // --- internal pose state ---
    private _x = 0;
    private _y = 0;
    private _theta = 0;
    private _linearVelocity = 0;
    private _angularVelocity = 0;
    private _reliable = true;

    // --- per-wheel tick tracking ---
    private _leftWheels: WheelTickState[] = [];
    private _rightWheels: WheelTickState[] = [];

    // --- event subscribers ---
    private _listeners: Array<(src: ISensor, data: IOdometryEvent[]) => void> = [];

    /**
     * @param wheels         Wheel positions — labels starting with "left" or
     *                       "right" determine side assignment. At least one
     *                       wheel per side is required.
     * @param wheelBase      Distance between left/right wheel tracks in meters.
     * @param slipThreshold  Slip ratio above which a wheel is excluded from
     *                       the per-side average. Default: 0.3.
     */
    public constructor(wheels: IWheelPosition[], wheelBase: number, slipThreshold = 0.3) {
        super();
        this.id = generateId("odometry");
        this.wheels = wheels;
        this.wheelBase = wheelBase;
        this.slipThreshold = slipThreshold;
        this._resolveWheels();
    }

    // -----------------------------------------------------------------------
    // ISensorReadable<IOdometryEstimate>
    // -----------------------------------------------------------------------

    /** Return the latest fused pose estimate. */
    public sensorRead(): IOdometryEstimate {
        return {
            x: this._x,
            y: this._y,
            theta: this._theta,
            linearVelocity: this._linearVelocity,
            angularVelocity: this._angularVelocity,
            reliable: this._reliable,
        };
    }

    // -----------------------------------------------------------------------
    // ISensorEventEmitter<IOdometryEvent>
    // -----------------------------------------------------------------------

    public onSensorEvent(callback: (src: ISensor, data: IOdometryEvent[]) => void): IDisposable {
        this._listeners.push(callback);
        return {
            dispose: () => {
                const idx = this._listeners.indexOf(callback);
                if (idx >= 0) this._listeners.splice(idx, 1);
            },
        };
    }

    // -----------------------------------------------------------------------
    // IDifferentialOdometryNode
    // -----------------------------------------------------------------------

    /** Zero the pose estimate and per-wheel tick baselines. */
    public reset(): void {
        this._x = 0;
        this._y = 0;
        this._theta = 0;
        this._linearVelocity = 0;
        this._angularVelocity = 0;
        this._reliable = true;

        for (const ws of this._leftWheels) ws.prevTicks = null;
        for (const ws of this._rightWheels) ws.prevTicks = null;
    }

    // -----------------------------------------------------------------------
    // ISimNode lifecycle
    // -----------------------------------------------------------------------

    /**
     * Per-frame odometry update.
     *
     * Steps:
     *   1. Aggregate left-side wheels (read, filter slip, average).
     *   2. Aggregate right-side wheels (same).
     *   3. Differential-drive kinematics (midpoint arc integration).
     *   4. Derive instantaneous velocities.
     *   5. Determine reliability from aggregation results.
     *   6. Emit updated estimate to subscribers.
     */
    protected override onSelfTick(dtMs: number): void {
        if (this._leftWheels.length === 0 || this._rightWheels.length === 0) return;

        const dtSec = dtMs / 1000;
        if (dtSec <= 0) return;

        // --- 1 & 2. Per-side aggregation ---
        const left = this._aggregateSide(this._leftWheels);
        const right = this._aggregateSide(this._rightWheels);

        // On the very first tick, aggregation returns null (baseline capture).
        if (left === null || right === null) return;

        // --- 3. Differential drive kinematics (midpoint integration) ---
        const dCenter = (left.displacement + right.displacement) / 2;
        const dTheta = (right.displacement - left.displacement) / this.wheelBase;

        const midTheta = this._theta + dTheta / 2;

        this._x += dCenter * Math.cos(midTheta);
        this._y += dCenter * Math.sin(midTheta);
        this._theta += dTheta;

        // Normalize theta to [−π, π].
        this._theta = Math.atan2(Math.sin(this._theta), Math.cos(this._theta));

        // --- 4. Instantaneous velocities ---
        this._linearVelocity = dCenter / dtSec;
        this._angularVelocity = dTheta / dtSec;

        // --- 5. Reliability ---
        // Unreliable if either side had zero contributing (non-slipping) wheels.
        this._reliable = left.contributing > 0 && right.contributing > 0;

        // --- 6. Emit to subscribers ---
        if (this._listeners.length > 0) {
            const estimate = this.sensorRead();
            const event: IOdometryEvent = {
                id: this.id,
                series: [
                    {
                        measurement: { schema: "odometry.differential" },
                        samples: [
                            {
                                value: estimate,
                                quality: this._reliable ? 192 : 64, // Good : Uncertain
                            },
                        ],
                    },
                ],
            };
            for (const listener of this._listeners) {
                listener(this, [event]);
            }
        }
    }

    protected override onSelfAdded(_space: ISimSpace): void {
        this._resolveWheels();
    }

    protected override onSelfRemoved(_space: ISimSpace): void {
        this._listeners.length = 0;
    }

    // -----------------------------------------------------------------------
    // IDisposable
    // -----------------------------------------------------------------------

    public override dispose(): void {
        super.dispose();
        this._listeners.length = 0;
        this._leftWheels.length = 0;
        this._rightWheels.length = 0;
    }

    // -----------------------------------------------------------------------
    // Private — per-side aggregation
    // -----------------------------------------------------------------------

    /**
     * Read all wheels on one side, compute per-wheel displacement,
     * filter out slipping wheels, and return the averaged displacement.
     *
     * Returns `null` on the first tick (baseline capture — no delta yet).
     *
     * @param sideWheels  Array of per-wheel tick states for this side.
     */
    private _aggregateSide(sideWheels: WheelTickState[]): SideAggregate | null {
        let firstTick = false;
        const displacements: { displacement: number; slipping: boolean }[] = [];

        for (const ws of sideWheels) {
            const data: IWheelEncoderData = ws.wheel.encoder.sensorRead();
            const currentTicks = data.ticks;

            // First tick: capture baseline.
            if (ws.prevTicks === null) {
                ws.prevTicks = currentTicks;
                firstTick = true;
                continue;
            }

            const deltaTicks = currentTicks - ws.prevTicks;
            ws.prevTicks = currentTicks;

            const displacement = deltaTicks * ws.metersPerTick;
            const slipping = (data.slipRatio ?? 0) >= this.slipThreshold;

            displacements.push({ displacement, slipping });
        }

        // If any wheel was on its first tick, skip this frame entirely
        // to avoid mixing partial data.
        if (firstTick) return null;

        const total = displacements.length;
        if (total === 0) return { displacement: 0, contributing: 0, total: 0 };

        // Filter to non-slipping wheels.
        const gripping = displacements.filter((d) => !d.slipping);
        const contributing = gripping.length;

        if (contributing > 0) {
            // Average only the wheels with traction.
            const sum = gripping.reduce((acc, d) => acc + d.displacement, 0);
            return { displacement: sum / contributing, contributing, total };
        }

        // All wheels on this side are slipping — fall back to raw average.
        // The estimate will be flagged unreliable.
        const sum = displacements.reduce((acc, d) => acc + d.displacement, 0);
        return { displacement: sum / total, contributing: 0, total };
    }

    // -----------------------------------------------------------------------
    // Private — wheel resolution
    // -----------------------------------------------------------------------

    /**
     * Partition enrolled wheels into left/right sides based on label prefix.
     *
     * - Labels starting with `"left"` → left side.
     * - Labels starting with `"right"` → right side.
     *
     * Pre-computes `metersPerTick` for each wheel to avoid repeated
     * division in the hot loop.
     */
    private _resolveWheels(): void {
        this._leftWheels = [];
        this._rightWheels = [];

        for (const w of this.wheels) {
            const label = w.label.toLowerCase();
            const config = w.encoder.config;
            const metersPerTick = (2 * Math.PI * config.wheelRadius) / config.ticksPerRevolution;

            const state: WheelTickState = {
                wheel: w,
                prevTicks: null,
                metersPerTick,
            };

            if (label.startsWith("left")) {
                this._leftWheels.push(state);
            } else if (label.startsWith("right")) {
                this._rightWheels.push(state);
            }
            // Wheels with other labels (e.g., "center") are ignored —
            // they don't contribute to differential drive kinematics.
        }

        if (this._leftWheels.length === 0 || this._rightWheels.length === 0) {
            throw new Error(`DifferentialOdometry requires at least one "left*" and one "right*" wheel. ` + `Found: [${this.wheels.map((w) => w.label).join(", ")}]`);
        }
    }
}
