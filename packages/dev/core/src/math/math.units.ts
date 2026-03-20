// ═══════════════════════════════════════════════════════════════════════════
// Unit system — physical units with automatic conversion
//
// Adapted from SpaceXR core math module.
// Provides Unit (name, symbol, conversion factor), Quantity (value + unit),
// and concrete quantity classes for all physical dimensions.
//
// Usage:
//   const d = new Length(1000, Length.Units.mm);
//   d.getValue(Length.Units.m)  // → 1.0
//   Quantity.Convert(1000, Length.Units.mm, Length.Units.m)  // → 1.0
// ═══════════════════════════════════════════════════════════════════════════

import { AbstractRange } from "./math.range";

// ─── Core types ──────────────────────────────────────────────────────────────

/**
 * Custom converter for non-linear unit relationships (e.g., temperature).
 */
export interface IUnitConverter {
    accept(u: Unit): boolean;
    convert(v: number, u: Unit): number;
}

/**
 * A physical unit with name, symbol, and a conversion value relative
 * to the base unit of its quantity (e.g., meter for Length, second for Time).
 *
 * The `value` field is the multiplier to convert TO the base unit:
 * `valueInBaseUnit = valueInThisUnit * unit.value`
 */
export class Unit {
    public constructor(
        public name: string,
        public symbol: string,
        public value: number = 0,
        public converter?: IUnitConverter
    ) {}
}

// ─── Quantity ─────────────────────────────────────────────────────────────────

/**
 * A numeric value with an associated unit. Supports automatic conversion
 * between units of the same quantity type.
 */
export abstract class Quantity {
    /**
     * Convert a value from one unit to another.
     * Uses custom converters if available, otherwise ratio of unit values.
     */
    public static Convert(value: number, from: Unit, to: Unit): number {
        if (!from || !to || from === to) {
            return value;
        }
        if (from.converter && from.converter.accept(to)) {
            return from.converter.convert(value, to);
        }
        return value * (from.value / to.value);
    }

    public _value: number;
    private _unit?: Unit;

    private static _defaultDecimalPrecision = 6;

    static round(value: number, decimalPrecision: number = Quantity._defaultDecimalPrecision): number {
        const dp = decimalPrecision || Quantity._defaultDecimalPrecision;
        return Math.round(value * Math.pow(10, dp)) / Math.pow(10, dp);
    }

    public constructor(value: number | Quantity, unit?: Unit) {
        if (value instanceof Quantity) {
            this._value = value.value;
            this._unit = value._unit;
        } else {
            this._value = value;
            this._unit = unit;
        }
    }

    public get unit(): Unit | undefined {
        return this._unit;
    }

    public set unit(target: Unit | undefined) {
        if (target && this._unit && this._unit !== target) {
            this.tryConvert(target);
        }
    }

    public get value(): number {
        return this._value;
    }

    public set value(value: number) {
        this._value = value;
    }

    public tryConvert(targetUnit: Unit): boolean {
        if (this._unit) {
            if (this._unit.converter) {
                if (this._unit.converter.accept(targetUnit) === false) {
                    return false;
                }
                this.value = this._unit.converter.convert(this.value, targetUnit);
                this._unit = targetUnit;
                return true;
            }
            if (targetUnit.value && targetUnit.symbol !== this._unit.symbol) {
                this.value *= this._unit.value / targetUnit.value;
                this._unit = targetUnit;
                return true;
            }
        }
        return false;
    }

    public getValue(unit?: Unit): number {
        if (!this._unit) {
            return this._value;
        }
        if (unit && unit !== this._unit) {
            if (this._unit.converter) {
                if (this._unit.converter.accept(unit)) {
                    return this._unit.converter.convert(this.value, unit);
                }
            }
            if (unit.value && unit.symbol !== this._unit.symbol) {
                return this.value * (this._unit.value / unit.value);
            }
        }
        return this.value;
    }

    public equals(v: Quantity): boolean {
        if (v._unit === this._unit) {
            return this.value === v.value;
        }
        return this.value === v.getValue(this._unit);
    }

    public abstract unitForSymbol(symbol: string): Unit | undefined;
}

// ─── Quantity range ──────────────────────────────────────────────────────────

export class QuantityRange<T extends Quantity> extends AbstractRange<T> {
    protected computeDelta(a: T, b: T): T {
        const constructor = a.constructor as new (value: number, unit?: Unit) => T;
        if (b && a) {
            return new constructor(b.value - (b.unit === a.unit ? a.value : a.getValue(b.unit)), b.unit);
        }
        return new constructor(0, a.unit);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Concrete quantity classes
// ═══════════════════════════════════════════════════════════════════════════

// ─── Length ───────────────────────────────────────────────────────────────────

export class Length extends Quantity {
    public static ForParameter(value: Length | number, defaultValue: number, defaultUnit: Unit): Length {
        return value ? new Length(value, defaultUnit) : new Length(defaultValue, defaultUnit);
    }

    public static Units: { [key: string]: Unit } = {
        nm: new Unit("nanometer", "nm", 1e-9),
        mim: new Unit("micrometer", "mim", 1e-6),
        mm: new Unit("millimeter", "mm", 1e-3),
        cm: new Unit("centimeter", "cm", 1e-2),
        in: new Unit("inch", "in", 0.0254),
        dm: new Unit("decimeter", "dm", 1e-1),
        m: new Unit("meter", "m", 1),
        ft: new Unit("foot", "ft", 0.3048),
        yd: new Unit("yard", "yd", 0.9144),
        Dam: new Unit("decameter", "Dm", 10),
        Hm: new Unit("hectometer", "Hm", 100),
        Km: new Unit("kilometer", "Km", 1000),
        Mi: new Unit("mile", "Mi", 1609.344),
        Nmi: new Unit("nautical mile", "Nmi", 1852),
        Mm: new Unit("megameter", "Mm", 1e6),
        Au: new Unit("astronomical unit", "Au", 1.496e11),
        Ly: new Unit("light year", "Ly", 9.4607e15),
        Pc: new Unit("parsec", "Pc", 3.0857e16),
    };

    public unitForSymbol(str: string): Unit | undefined {
        return Length.Units[str] || undefined;
    }
}

// ─── Mass ─────────────────────────────────────────────────────────────────────

export class Mass extends Quantity {
    public static ForParameter(value: Mass | number, defaultValue: number, defaultUnit: Unit): Mass {
        return value ? new Mass(value, defaultUnit) : new Mass(defaultValue, defaultUnit);
    }

    public static Units: { [key: string]: Unit } = {
        mg: new Unit("microgram", "mg", 1e-6),
        g: new Unit("gram", "g", 1e-3),
        oz: new Unit("ounce", "oz", 0.028349523125),
        pound: new Unit("pound", "lb", 0.45359237),
        kg: new Unit("kilogram", "kg", 1),
        T: new Unit("ton", "T", 1000),
    };

    public unitForSymbol(str: string): Unit | undefined {
        return Mass.Units[str] || undefined;
    }
}

// ─── Timespan ─────────────────────────────────────────────────────────────────

export class Timespan extends Quantity {
    public static ForParameter(value: Timespan | number, defaultValue: number, defaultUnit: Unit): Timespan {
        return value ? new Timespan(value, defaultUnit) : new Timespan(defaultValue, defaultUnit);
    }

    public static Units: { [key: string]: Unit } = {
        ns: new Unit("nanosecond", "ns", 1e-9),
        mis: new Unit("microsecond", "mis", 1e-6),
        ms: new Unit("millisecond", "ms", 1e-3),
        s: new Unit("second", "s", 1),
        Min: new Unit("minute", "m", 60),
        Hour: new Unit("hour", "h", 3600),
        Day: new Unit("day", "d", 86400),
    };

    public unitForSymbol(str: string): Unit | undefined {
        return Timespan.Units[str] || undefined;
    }
}

// ─── Angle ────────────────────────────────────────────────────────────────────

export class Angle extends Quantity {
    public static ForParameter(value: Angle | number, defaultValue: number, defaultUnit: Unit): Angle {
        return value ? new Angle(value, defaultUnit) : new Angle(defaultValue, defaultUnit);
    }

    public static PIBY2 = Math.PI / 2;
    public static PIBY4 = Math.PI / 4;
    public static DE2RA = Math.PI / 180;
    public static RA2DE = 180 / Math.PI;

    public static Units: { [key: string]: Unit } = {
        d: new Unit("degree", "d", 1),
        r: new Unit("radian", "r", Angle.RA2DE),
    };

    public unitForSymbol(str: string): Unit | undefined {
        return Angle.Units[str] || undefined;
    }
}

// ─── Temperature ──────────────────────────────────────────────────────────────

class KConverter implements IUnitConverter {
    public accept(unit: Unit): boolean {
        return unit === Temperature.Units.c || unit === Temperature.Units.f;
    }
    public convert(value: number, unit: Unit): number {
        switch (unit) {
            case Temperature.Units.c:
                return value - Temperature.Units.k.value;
            case Temperature.Units.f:
                return (value - Temperature.Units.k.value) * 1.8 + 32;
            default:
                return value;
        }
    }
}

class CConverter implements IUnitConverter {
    public accept(unit: Unit): boolean {
        return unit === Temperature.Units.k || unit === Temperature.Units.f;
    }
    public convert(value: number, unit: Unit): number {
        switch (unit) {
            case Temperature.Units.k:
                return value + Temperature.Units.k.value;
            case Temperature.Units.f:
                return value * 1.8 + 32;
            default:
                return value;
        }
    }
}

class FConverter implements IUnitConverter {
    public accept(unit: Unit): boolean {
        return unit === Temperature.Units.k || unit === Temperature.Units.c;
    }
    public convert(value: number, unit: Unit): number {
        switch (unit) {
            case Temperature.Units.k:
                return (value - 32) / 1.8 + Temperature.Units.k.value;
            case Temperature.Units.c:
                return (value - 32) / 1.8;
            default:
                return value;
        }
    }
}

export class Temperature extends Quantity {
    public static ForParameter(value: Temperature | number, defaultValue: number, defaultUnit: Unit): Temperature {
        return value ? new Temperature(value, defaultUnit) : new Temperature(defaultValue, defaultUnit);
    }

    public static Units: { [key: string]: Unit } = {
        k: new Unit("kelvin", "k", 273.15, new KConverter()),
        c: new Unit("celsius", "c", 1, new CConverter()),
        f: new Unit("fahrenheit", "f", 33.8, new FConverter()),
    };

    public unitForSymbol(str: string): Unit | undefined {
        return Temperature.Units[str] || undefined;
    }
}

// ─── Speed ────────────────────────────────────────────────────────────────────

export class Speed extends Quantity {
    public static Units: { [key: string]: Unit } = {
        mps: new Unit("meters per second", "m/s", 1),
        kmph: new Unit("kilometers per hour", "km/h", 1 / 3.6),
        mph: new Unit("miles per hour", "mph", 0.44704),
        kn: new Unit("knot", "kn", 0.514444),
    };

    public unitForSymbol(str: string): Unit | undefined {
        return Speed.Units[str] || undefined;
    }
}

// ─── Power ────────────────────────────────────────────────────────────────────

export class Power extends Quantity {
    public static Units: { [key: string]: Unit } = {
        watt: new Unit("watt", "w", 1),
        Kwatt: new Unit("kilowatt", "kw", 1000),
    };

    public unitForSymbol(str: string): Unit | undefined {
        return Power.Units[str] || undefined;
    }
}

// ─── Voltage ──────────────────────────────────────────────────────────────────

export class Voltage extends Quantity {
    public static Units: { [key: string]: Unit } = {
        volt: new Unit("volt", "v", 1),
    };

    public unitForSymbol(str: string): Unit | undefined {
        return Voltage.Units[str] || undefined;
    }
}

// ─── Current ──────────────────────────────────────────────────────────────────

export class Current extends Quantity {
    public static Units: { [key: string]: Unit } = {
        amp: new Unit("ampere", "a", 1),
    };

    public unitForSymbol(str: string): Unit | undefined {
        return Current.Units[str] || undefined;
    }
}
