import { IGraph, INode, IOlink } from "@spiky-panda/core";

/**
 * A node that participates in the discrete-time simulation loop.
 *
 * Every entity that needs per-frame updates (sensors, actuators, physics
 * bodies, navigation brains, …) implements `ISimNode` and is added to an
 * `ISimSpace`. The simulation engine calls the lifecycle methods in order:
 *
 * 1. **`onAdded(space, parent?)`** — called once when the node is inserted
 *    into the simulation graph. Use this for initialization that depends on
 *    the space context (e.g., registering event listeners, acquiring GPU
 *    resources, resolving sibling nodes).
 *
 * 2. **`onTick(dtMs)`** — called every simulation step with the elapsed
 *    time in milliseconds since the previous tick. This is the hot path:
 *    read sensors, run inference, update state, emit events.
 *
 * 3. **`onRemoved(space, parent?)`** — called once when the node is
 *    detached from the graph. Clean up subscriptions, release resources.
 *
 * @extends INode  Inherits identity and graph connectivity from the
 *                 core graph library.
 */
export interface ISimNode extends INode {
    /**
     * Per-frame update callback.
     * @param dtMs  Delta time in milliseconds since the last tick.
     *              Implementations should scale time-dependent logic
     *              by this value to remain frame-rate independent.
     */
    onTick(dtMs: number): void;

    /**
     * Called when this node is added to a simulation space.
     * @param space   The simulation graph this node now belongs to.
     * @param parent  Optional parent node if this node is nested
     *                (e.g., an accelerometer inside an IMU composite).
     */
    onAdded(space: ISimSpace, parent?: ISimNode): void;

    /**
     * Called when this node is removed from a simulation space.
     * @param space   The simulation graph this node is leaving.
     * @param parent  Optional parent node if this node was nested.
     */
    onRemoved(space: ISimSpace, parent?: ISimNode): void;
}

/**
 * The simulation graph — a directed graph of `ISimNode` entities
 * connected by `IOlink` edges.
 *
 * The space owns the tick loop and is responsible for calling
 * `onTick(dtMs)` on every enrolled node each frame. Nodes can be
 * added or removed at any time; the space fires `onAdded` / `onRemoved`
 * accordingly.
 *
 * @extends IGraph<ISimNode, IOlink>  Inherits node/edge CRUD, traversal,
 *                                     and topology queries from the core
 *                                     graph library.
 */
export interface ISimSpace extends IGraph<ISimNode, IOlink> {}
