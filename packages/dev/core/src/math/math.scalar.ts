// ═══════════════════════════════════════════════════════════════════════════
// Scalar utilities and parametric type
// Adapted from SpaceXR core math module.
// ═══════════════════════════════════════════════════════════════════════════

/** A number in [0, 1] representing a parametric position along a curve or gradient. */
export type ParametricValue = number;

/**
 * Static scalar math utilities.
 */
export class Scalar {
    public static EPSILON = 1.401298e-45;
    public static DEG2RAD = Math.PI / 180;
    public static RAD2DEG = 180 / Math.PI;
    public static INCH2METER = 0.0254;
    public static METER2INCH = 39.3701;

    public static PI = Math.PI;
    public static PI_2 = Math.PI / 2;
    public static PI_4 = Math.PI / 4;

    public static WithinEpsilon(a: number, epsilon: number = Scalar.EPSILON): boolean {
        return -epsilon <= a && a <= epsilon;
    }

    public static Sign(value: number): number {
        return value > 0 ? 1 : -1;
    }

    public static Clamp(value: number, min: number = 0, max: number = 1): number {
        return Math.min(max, Math.max(min, value));
    }

    public static Smoothstep(t: number): number {
        const x = Scalar.Clamp(t, 0, 1);
        return x * x * (3 - 2 * x);
    }

    public static Lerp(a: number, b: number, t: number): number {
        return a + (b - a) * t;
    }

    public static GetRandomInt(min: number, max: number): number {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    public static ToHex(i: number): string {
        const str = i.toString(16);
        if (i <= 15) {
            return ("0" + str).toUpperCase();
        }
        return str.toUpperCase();
    }
}
