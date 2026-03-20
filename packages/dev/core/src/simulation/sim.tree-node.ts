// ═══════════════════════════════════════════════════════════════════════════
// SimTreeNode — base class for all simulation tree entities
//
// Extends GraphNode (preserving INode graph compatibility) and adds
// ITreeNode parent/child management plus automatic lifecycle propagation.
//
// Subclasses override onSelfTick / onSelfAdded / onSelfRemoved for their
// own logic. The onTick / onAdded / onRemoved methods handle propagation
// to children and should not be overridden.
// ═══════════════════════════════════════════════════════════════════════════

import { GraphNode } from "@spiky-panda/core";
import { ISimNode, ISimSpace } from "./sim.interfaces";
import { ITreeNode } from "@dev/core/collections";

/**
 * Base class for simulation tree nodes.
 *
 * Extends `GraphNode` (preserving `INode` graph compatibility — edges,
 * position, bag) and adds `ITreeNode` parent/child management with
 * automatic lifecycle propagation.
 *
 * **Template method pattern:**
 * - Override `onSelfTick(dtMs)` for per-frame logic.
 * - Override `onSelfAdded(space, parent)` for initialization.
 * - Override `onSelfRemoved(space, parent)` for cleanup.
 *
 * The `onTick` / `onAdded` / `onRemoved` methods call the `onSelf*`
 * hook first (parent processes before children), then iterate children.
 *
 * **Usage:**
 * ```typescript
 * class MySensor extends SimTreeNode {
 *     protected onSelfTick(dtMs: number): void {
 *         // read sensor, update state
 *     }
 * }
 *
 * class MyComposite extends SimTreeNode {
 *     constructor() {
 *         super();
 *         this.addChild(new MySensor());  // auto-propagated
 *     }
 * }
 * ```
 */
export abstract class SimTreeNode extends GraphNode implements ISimNode {
    private _parent: ISimNode | undefined;
    private _children: ISimNode[] = [];
    private _space: ISimSpace | undefined;

    // ── ITreeNode ────────────────────────────────────────────────────────

    public get parent(): ISimNode | undefined {
        return this._parent;
    }

    public get children(): ReadonlyArray<ISimNode> {
        return this._children;
    }

    /**
     * Add a child node. Sets the child's parent to this node.
     * If this node is already in a simulation space, the child
     * receives `onAdded` automatically.
     */
    public addChild<T extends ITreeNode>(child: T): T {
        const simChild = child as unknown as SimTreeNode;
        simChild._parent = this;
        this._children.push(simChild);

        // If we're already in a space, propagate onAdded to the new child
        if (this._space) {
            simChild.onAdded(this._space, this);
        }
        return child;
    }

    /**
     * Remove a child node. Clears the child's parent.
     * If this node is in a space, the child receives `onRemoved`.
     */
    public removeChild(child: ITreeNode): boolean {
        const idx = this._children.indexOf(child as ISimNode);
        if (idx < 0) return false;

        const simChild = this._children[idx] as SimTreeNode;
        this._children.splice(idx, 1);
        simChild._parent = undefined;

        if (this._space) {
            simChild.onRemoved(this._space, this);
        }
        return true;
    }

    /**
     * Walk the tree depth-first, calling visitor on each node.
     * Return false from visitor to prune that subtree.
     */
    public traverse(visitor: (node: ITreeNode, depth: number) => boolean | void): void {
        this._traverseImpl(visitor, 0);
    }

    private _traverseImpl(visitor: (node: ITreeNode, depth: number) => boolean | void, depth: number): void {
        const result = visitor(this, depth);
        if (result === false) return;
        for (const child of this._children) {
            if (child instanceof SimTreeNode) {
                child._traverseImpl(visitor, depth + 1);
            }
        }
    }

    // ── Subclass hooks (override these, not onTick/onAdded/onRemoved) ────

    /**
     * Override for node-specific per-frame logic.
     * Called BEFORE children are ticked.
     */
    protected onSelfTick(_dtMs: number): void {
        // default: no-op
    }

    /**
     * Override for node-specific initialization.
     * Called BEFORE children receive onAdded.
     */
    protected onSelfAdded(_space: ISimSpace, _parent?: ISimNode): void {
        // default: no-op
    }

    /**
     * Override for node-specific cleanup.
     * Called BEFORE children receive onRemoved.
     */
    protected onSelfRemoved(_space: ISimSpace, _parent?: ISimNode): void {
        // default: no-op
    }

    // ── ISimNode lifecycle (propagation — do not override) ───────────────

    /**
     * Tick this node then all children (depth-first, parent-first).
     * Override `onSelfTick()` instead.
     */
    public onTick(dtMs: number): void {
        this.onSelfTick(dtMs);
        for (const child of this._children) {
            child.onTick(dtMs);
        }
    }

    /**
     * Initialize this node then all children.
     * Override `onSelfAdded()` instead.
     */
    public onAdded(space: ISimSpace, parent?: ISimNode): void {
        this._space = space;
        if (parent) {
            this._parent = parent;
        }
        this.onSelfAdded(space, parent);
        for (const child of this._children) {
            child.onAdded(space, this);
        }
    }

    /**
     * Clean up this node then all children.
     * Override `onSelfRemoved()` instead.
     */
    public onRemoved(space: ISimSpace, parent?: ISimNode): void {
        this.onSelfRemoved(space, parent);
        for (const child of this._children) {
            child.onRemoved(space, this);
        }
        this._space = undefined;
        this._parent = undefined;
    }

    /** Recursively dispose children, then self. */
    public override dispose(): void {
        for (const child of [...this._children]) {
            if (child instanceof SimTreeNode) {
                child.dispose();
            }
        }
        this._children.length = 0;
        this._parent = undefined;
        this._space = undefined;
        super.dispose();
    }

    // ── Protected accessor for subclasses ────────────────────────────────

    /** The simulation space this node belongs to (set after onAdded). */
    protected get space(): ISimSpace | undefined {
        return this._space;
    }
}
