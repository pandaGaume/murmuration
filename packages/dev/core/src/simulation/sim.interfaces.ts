import { IGraph, IOlink } from "@spiky-panda/core";
import { ISceneContext, ITreeNode } from "@dev/core/collections";

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
 * @extends ITreeNode  Inherits parent-child hierarchy, identity, and
 *                     graph connectivity from the tree/graph library.
 *                     Lifecycle calls (onTick, onAdded, onRemoved)
 *                     propagate automatically down the tree.
 */
export interface ISimNode extends ITreeNode {
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
 * The simulation space — the root container and scene.
 *
 * The space IS the scene: it owns the tree of `ISimNode` entities,
 * holds the `ISceneContext` (units, coordinate frame, gravity), and
 * drives the tick loop. It also decorates an `IGraph<ISimNode, IOlink>`
 * for flat graph connectivity (data flow edges between nodes).
 *
 * Nodes access the scene context via the space reference they receive
 * in `onAdded(space)`:
 *
 * ```typescript
 * protected onSelfAdded(space: ISimSpace): void {
 *     const lengthUnit = space.context.units.length; // e.g., Length.Units.m
 * }
 * ```
 *
 * @extends IGraph<ISimNode, IOlink>  Inherits node/edge CRUD, traversal,
 *                                     and topology queries from the core
 *                                     graph library.
 */
export interface ISimSpace extends IGraph<ISimNode, IOlink> {
    /**
     * Global scene context: physical units, coordinate frame, gravity.
     *
     * Every node in the space can read this to know what units the
     * scene operates in, enabling correct unit conversion for sensor
     * data, physics, and navigation.
     */
    readonly context: ISceneContext;
}
