import { IDisposable, IIdentifiable, generateId } from "@myorg/core";

/**
 * A simple counter that implements both IIdentifiable and IDisposable.
 */
export class Counter implements IIdentifiable, IDisposable {
    readonly id: string;
    private _count = 0;

    constructor() {
        this.id = generateId("counter");
    }

    get count(): number {
        return this._count;
    }

    increment(): number {
        return ++this._count;
    }

    reset(): void {
        this._count = 0;
    }

    dispose(): void {
        this._count = 0;
    }
}
