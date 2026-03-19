import { IIdentifiable, generateId } from "@myorg/core";

/**
 * A simple greeter that implements IIdentifiable.
 */
export class Greeter implements IIdentifiable {
    readonly id: string;
    constructor(public readonly name: string) {
        this.id = generateId("greeter");
    }

    greet(): string {
        return `Hello, ${this.name}! (id: ${this.id})`;
    }
}
