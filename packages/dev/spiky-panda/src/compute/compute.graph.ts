// ═══════════════════════════════════════════════════════════════════════════
// ComputeGraph — executes a DAG of compute nodes in topological order
//
// Each call to run():
// 1. Inject external inputs into source nodes
// 2. Walk nodes in topological order
// 3. For each node: gather input tensors from incoming IDataLinks,
//    call execute(), write output tensors to outgoing IDataLinks
// 4. Collect output tensors from sink nodes
//
// The topological order is computed once at construction (or when the
// graph changes) and cached for fast per-frame execution.
// ═══════════════════════════════════════════════════════════════════════════

import { Graph, GraphOLink } from "@spiky-panda/core";
import {
    IComputeGraph,
    IComputeNode,
    IComputeNodeBag,
    IDataLink,
    ITensor,
} from "./compute.interfaces";

// ─── DataLink implementation ─────────────────────────────────────────────────

/**
 * Concrete data link: a directed edge carrying a tensor.
 */
export class DataLink extends GraphOLink implements IDataLink {
    public tensor: ITensor | null = null;

    public constructor(from?: IComputeNode, to?: IComputeNode) {
        super(from, to);
    }
}

// ─── ComputeGraph implementation ─────────────────────────────────────────────

/**
 * Executable compute graph.
 *
 * Extends `Graph<IComputeNode, IDataLink>` from @spiky-panda/core,
 * adding topological sort and the `run()` execution method.
 *
 * **Usage:**
 * ```typescript
 * const graph = new ComputeGraph(nodes, links);
 * const result = graph.run(new Map([["pose", poseTensor]]));
 * const command = result.get("command");
 * ```
 */
export class ComputeGraph extends Graph<IComputeNode, IDataLink> implements IComputeGraph {
    private _sortedNodes: IComputeNode[] | null = null;

    public constructor(nodes: IComputeNode[], links: IDataLink[]) {
        super(nodes, links);
    }

    /**
     * Execute the full graph in topological order.
     *
     * @param externalInputs  Named tensors injected into source nodes
     *                         (matched by node ID or name tag).
     * @returns                Named tensors from output nodes.
     */
    public run(externalInputs?: Map<string, ITensor>): Map<string, ITensor> {
        const sorted = this._getTopologicalOrder();

        for (const node of sorted) {
            // Gather inputs from incoming links
            const incomingLinks = node.opsc<IDataLink>();
            const inputs: ITensor[] = [];

            if (incomingLinks.length === 0 && externalInputs) {
                // Source node: check for external input by ID or tag
                const key = (node.id as string) ?? node.tag;
                if (key) {
                    const ext = externalInputs.get(key);
                    if (ext) {
                        inputs.push(ext);
                    }
                }
            } else {
                // Transform node: read tensors from incoming data links
                for (const link of incomingLinks) {
                    if (link.tensor) {
                        inputs.push(link.tensor);
                    }
                }
            }

            // Execute the node
            const outputs = node.execute(inputs);

            // Cache outputs in the node's bag
            const bag = (node.bag ?? {}) as IComputeNodeBag;
            bag.lastOutputs = outputs;
            node.bag = bag;

            // Write outputs to outgoing data links
            const outgoingLinks = node.onsc<IDataLink>();
            for (let i = 0; i < outgoingLinks.length; i++) {
                // If there are multiple outputs, distribute them; otherwise broadcast
                outgoingLinks[i].tensor = outputs.length > 1 ? (outputs[i] ?? outputs[0]) : (outputs[0] ?? null);
            }
        }

        // Collect outputs from sink nodes (nodes with no successors)
        const result = new Map<string, ITensor>();
        for (const node of this.outputs) {
            const bag = node.bag as IComputeNodeBag | undefined;
            if (bag?.lastOutputs) {
                const key = (node.id as string) ?? node.tag ?? node.nodeType;
                for (const tensor of bag.lastOutputs) {
                    result.set(tensor.name ?? key, tensor);
                }
            }
        }

        return result;
    }

    /**
     * Invalidate the cached topological order.
     * Call after adding/removing nodes or links.
     */
    public invalidateOrder(): void {
        this._sortedNodes = null;
    }

    // ── Topological sort (Kahn's algorithm) ──────────────────────────────

    private _getTopologicalOrder(): IComputeNode[] {
        if (this._sortedNodes) return this._sortedNodes;

        const sorted: IComputeNode[] = [];
        const inDegree = new Map<IComputeNode, number>();

        // Initialize in-degrees
        for (const node of this.nodes) {
            inDegree.set(node, node.opsc<IDataLink>().length);
        }

        // Start with source nodes (in-degree = 0)
        const queue: IComputeNode[] = [];
        for (const [node, degree] of inDegree) {
            if (degree === 0) {
                queue.push(node);
            }
        }

        while (queue.length > 0) {
            const node = queue.shift()!;
            sorted.push(node);

            // For each outgoing link, reduce the destination's in-degree
            for (const link of node.onsc<IDataLink>()) {
                const dest = link.ofin as IComputeNode;
                if (dest) {
                    const newDegree = (inDegree.get(dest) ?? 1) - 1;
                    inDegree.set(dest, newDegree);
                    if (newDegree === 0) {
                        queue.push(dest);
                    }
                }
            }
        }

        if (sorted.length !== this.nodes.length) {
            throw new Error(
                `ComputeGraph has a cycle: sorted ${sorted.length} of ${this.nodes.length} nodes. ` +
                `Compute graphs must be DAGs.`
            );
        }

        this._sortedNodes = sorted;
        return sorted;
    }
}
