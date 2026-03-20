// ═══════════════════════════════════════════════════════════════════════════
// Tree node interfaces — parent-child hierarchy for simulation entities
//
// Simulation entities form a tree:
//   Scene (root) → Rover → Sensors (IMU, LiDAR, Wheels)
//
// ITreeNode extends INode (from @spiky-panda/core) so it stays compatible
// with the flat graph infrastructure (edges, position) while adding
// hierarchical structure with automatic lifecycle propagation.
// ═══════════════════════════════════════════════════════════════════════════

import { INode } from "@spiky-panda/core";
import { Unit } from "@dev/core/math";

// ─── Tree node ───────────────────────────────────────────────────────────────

/**
 * A node that participates in a parent-child tree hierarchy.
 *
 * Extends INode so it remains compatible with the @spiky-panda/core
 * graph infrastructure (edges via onsc/opsc, position, etc.) while
 * adding hierarchical structure.
 */
export interface ITreeNode extends INode {
    /** The parent node in the tree, or undefined if this is a root. */
    readonly parent: ITreeNode | undefined;

    /** Ordered list of child nodes. */
    readonly children: ReadonlyArray<ITreeNode>;

    /**
     * Add a child node. Sets the child's parent to this node.
     * If this node is already in a simulation space, the child
     * receives `onAdded` automatically.
     * @returns The added child (for chaining).
     */
    addChild<T extends ITreeNode>(child: T): T;

    /**
     * Remove a child node. Clears the child's parent.
     * If this node is in a simulation space, the child
     * receives `onRemoved` automatically.
     * @returns true if the child was found and removed.
     */
    removeChild(child: ITreeNode): boolean;

    /**
     * Walk the tree depth-first, calling visitor on each node.
     * The visitor receives the node and its depth (root = 0).
     * Return false from visitor to prune that subtree.
     */
    traverse(visitor: (node: ITreeNode, depth: number) => boolean | void): void;
}

// ─── Scene context ───────────────────────────────────────────────────────────

/**
 * Coordinate frame convention.
 *
 * Defines the up axis and handedness of the coordinate system.
 * - Babylon.js uses `"Y-up-left"` (left-handed, Y up).
 * - Three.js uses `"Y-up-right"` (right-handed, Y up).
 * - Cesium uses `"Z-up-right"` (right-handed, Z up, ECEF).
 */
export type CoordinateFrame = "Y-up-right" | "Z-up-right" | "Y-up-left" | "Z-up-left";

/**
 * Scene-level unit configuration.
 *
 * Each field is a `Unit` instance from the unit system (e.g., `Length.Units.m`,
 * `Mass.Units.kg`). This tells every node in the tree what physical units
 * the scene's coordinate values are expressed in.
 *
 * Conversion between units uses `Quantity.Convert()`:
 * ```typescript
 * // Scene uses millimeters, sensor reports in meters:
 * const sceneValue = Quantity.Convert(sensorMeters, Length.Units.m, scene.context.units.length);
 * ```
 */
export interface ISceneUnits {
    /** Distance unit for scene coordinates (e.g., `Length.Units.m`). */
    readonly length: Unit;

    /** Mass unit (e.g., `Mass.Units.kg`). */
    readonly mass: Unit;

    /** Time unit (e.g., `Timespan.Units.s`). */
    readonly time: Unit;

    /** Angle unit (e.g., `Angle.Units.r` for radians). */
    readonly angle: Unit;
}

/**
 * Global simulation properties held by the `ISimSpace`.
 *
 * The space IS the scene — it owns the tree of nodes and defines
 * the physical context (units, coordinate frame, gravity) that all
 * nodes operate within. Nodes access the context via their space
 * reference (set during `onAdded`).
 */
export interface ISceneContext {
    /** Physical units used in this scene. */
    readonly units: ISceneUnits;

    /** Coordinate system convention. */
    readonly coordinateFrame: CoordinateFrame;

    /**
     * Gravitational acceleration magnitude in scene units.
     * Expressed in `units.length / units.time²`.
     * Default: 9.81 (m/s² for SI scenes).
     */
    readonly gravity: number;

    /** Optional scene-wide metadata. */
    readonly metadata?: Record<string, unknown>;
}

