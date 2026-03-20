// ═══════════════════════════════════════════════════════════════════════════
// Generic range — min/max with lazy delta computation
// Adapted from SpaceXR core math module.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Abstract generic range with min, max, and lazy delta.
 */
export abstract class AbstractRange<T> {
    protected _min: T;
    protected _max?: T;
    protected _d?: T;

    public constructor(min: T, max?: T) {
        this._min = min;
        this._max = max;
    }

    public get min(): T {
        return this._min;
    }

    public set min(m: T) {
        this._min = m;
        this._d = undefined;
    }

    public get max(): T | undefined {
        return this._max;
    }

    public set max(m: T | undefined) {
        this._max = m;
        this._d = undefined;
    }

    public get delta(): T {
        if (this._d === undefined) {
            this._d = this.computeDelta(this._min, this._max);
        }
        return this._d;
    }

    protected abstract computeDelta(a: T, b?: T): T;
}

/**
 * Numeric range with min, max, and delta.
 */
export class Range extends AbstractRange<number> {
    public static Zero(): Range {
        return new Range(0, 0);
    }

    public static Max(): Range {
        return new Range(Number.MIN_VALUE, Number.MAX_VALUE);
    }

    protected computeDelta(a: number, b?: number): number {
        return a !== undefined && b !== undefined ? b - a : Number.POSITIVE_INFINITY;
    }

    public constructor(min: number, max?: number) {
        super(min, max);
    }
}
