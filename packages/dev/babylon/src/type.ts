/**
 * Babylon.js ↔ murmuration-core type compatibility notes.
 *
 * Babylon's `Vector3` and spiky-panda's `ICartesian3` share the same
 * data shape (`{ x, y, z }`) but have **incompatible method signatures**:
 *
 * - `ICartesian3.subtract(b: ICartesian): this`  — accepts any ICartesian, returns polymorphic `this`
 * - `Vector3.subtract(other: DeepImmutableObject<Vector3LikeInternal>): Vector3` — requires internal `_x,_y,_z`
 *
 * Because the method contracts differ, `Vector3` **cannot** structurally
 * extend `ICartesian3`.  Module augmentation (`declare module`) would
 * produce TS2430 at compile time.
 *
 * **Strategy — Adapter at the boundary**
 *
 * Use `toCartesian3()` / `fromCartesian3()` from `./utils/babylon.math-bridge`
 * whenever crossing between Babylon land and core interfaces.  This keeps
 * core interfaces framework-agnostic and avoids forcing Babylon types into
 * a shape they weren't designed for.
 *
 * @see {@link ./utils/babylon.math-bridge.ts} for conversion helpers.
 *
 * @example
 * ```typescript
 * import { toCartesian3, fromCartesian3 } from "murmuration-babylon";
 * import { Vector3 } from "@babylonjs/core";
 *
 * const bv = new Vector3(1, 2, 3);
 * const ic = toCartesian3(bv);      // { x: 1, y: 2, z: 3 } — ICartesian3
 * const bv2 = fromCartesian3(ic);   // Vector3(1, 2, 3)
 * ```
 */

// Re-export adapter helpers for convenience so consumers can import from
// the package root without reaching into utils/.
export { toCartesian3, fromCartesian3 } from "./utils/babylon.math-bridge";
