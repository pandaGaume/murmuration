import { Cartesian3, ICartesian3 } from "@spiky-panda/core";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";

/**
 * Convert an `ICartesian3` to a Babylon.js `Vector3`.
 */
export function fromCartesian3(c: ICartesian3): Vector3 {
    return new Vector3(c.x, c.y, c.z);
}

export function toCartesian3(v: Vector3): ICartesian3 {
    return new Cartesian3(v.x, v.y, v.z);
}

/**
 * Compute angular velocity (rad/s) from two consecutive quaternion samples.
 *
 * The algorithm:
 *   1. Compute the delta quaternion: `dQ = curr * inverse(prev)`.
 *   2. Ensure the short-arc path (flip if `w < 0`).
 *   3. Extract the rotation angle: `angle = 2 * acos(clamp(w, -1, 1))`.
 *   4. Extract the rotation axis from the vector part, normalized.
 *   5. Scale by `1 / dtSec` to get angular velocity.
 *
 * @param prev   Quaternion at the previous tick.
 * @param curr   Quaternion at the current tick.
 * @param dtSec  Time delta in seconds.
 * @returns      Angular velocity as `ICartesian3` (gx, gy, gz) in rad/s.
 */
export function angularVelocityFromQuaternions(prev: Quaternion, curr: Quaternion, dtSec: number): Vector3 {
    if (dtSec <= 0) return Vector3.Zero();

    // Delta quaternion: how much rotation happened this frame.
    const invPrev = Quaternion.Inverse(prev);
    const dQ = curr.multiply(invPrev);

    // Ensure short-arc path.
    let w = dQ.w;
    let x = dQ.x;
    let y = dQ.y;
    let z = dQ.z;
    if (w < 0) {
        w = -w;
        x = -x;
        y = -y;
        z = -z;
    }

    // Clamp w to [-1, 1] to handle floating-point drift.
    w = Math.max(-1, Math.min(1, w));
    const angle = 2 * Math.acos(w);

    // If the angle is near zero, angular velocity is ~0.
    const sinHalfAngle = Math.sqrt(x * x + y * y + z * z);
    if (sinHalfAngle < 1e-8) {
        return Vector3.Zero();
    }

    // Axis (normalized) scaled by angular speed.
    const speed = angle / dtSec;
    const scale = speed / sinHalfAngle;

    return new Vector3(x * scale, y * scale, z * scale);
}
