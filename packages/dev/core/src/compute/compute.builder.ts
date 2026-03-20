// ═══════════════════════════════════════════════════════════════════════════
// PipelineBuilder — fluent factory for common navigation pipeline configs
//
// Creates pre-wired ComputeGraph instances for the most common
// depth-to-navigation configurations. Custom graphs can be built
// manually using ComputeGraph, DataLink, and individual nodes.
// ═══════════════════════════════════════════════════════════════════════════

import { IConvolutionConfig } from "@dev/core/perception";
import { IComputeNode } from "@dev/spiky-panda/compute";
import { ComputeGraph, DataLink } from "@dev/spiky-panda/compute";
import {
    ConcatNode,
    ConvolutionNode,
    DepthFusionComputeNode,
    ExternalInputNode,
    MLPNode,
} from "./compute.nodes";
import { IMatchingCortexConfig, MatchingCortexNode } from "./compute.matching-cortex";

// ─── Shared config types ─────────────────────────────────────────────────────

/**
 * MLP evaluation function type (from PerceptCortex or DecisionCortex).
 */
export type MLPEvaluator = (input: number[]) => number[];

/**
 * Common config for all pipeline builders.
 */
export interface IPipelineConfig {
    /** PerceptCortex evaluate function. Input: 42 → Output: 8. */
    perceptEvaluate: MLPEvaluator;

    /** DecisionCortex evaluate function. Input: 21 → Output: 4. */
    decisionEvaluate: MLPEvaluator;

    /** Convolution config for depth → sectors. */
    convolution: IConvolutionConfig;

    /** Depth buffer dimensions (for convolution input). */
    depthBufferWidth: number;
    depthBufferHeight: number;
}

// ─── Helper: connect two nodes ───────────────────────────────────────────────

function connect(from: IComputeNode, to: IComputeNode): DataLink {
    const link = new DataLink(from, to);
    from.onsc<DataLink>().push(link);
    to.opsc<DataLink>().push(link);
    return link;
}

// ─── Helper: build the common percept → decision tail ────────────────────────

function buildPerceptDecisionTail(
    sectorSource: IComputeNode,
    config: IPipelineConfig,
    nodes: IComputeNode[],
    links: DataLink[]
): void {
    // External inputs for IMU, pose, slip, goal
    const imuInput = new ExternalInputNode("imu", [6]);
    const poseInput = new ExternalInputNode("pose", [6]);
    const slipInput = new ExternalInputNode("slip", [4]);
    const goalInput = new ExternalInputNode("goal", [3]);

    // Concat sectors + IMU → PerceptCortex input (42)
    const perceptConcat = new ConcatNode([config.convolution.cols, 6], "percept_input");

    // PerceptCortex MLP (42 → 8)
    const perceptNode = new MLPNode("percept_cortex", 42, 8, config.perceptEvaluate, "percept_features");

    // Concat features + pose + slip + goal → DecisionCortex input (21)
    const decideConcat = new ConcatNode([8, 6, 4, 3], "decide_input");

    // DecisionCortex MLP (21 → 4)
    const decideNode = new MLPNode("decision_cortex", 21, 4, config.decisionEvaluate, "command");

    // Wire up
    links.push(connect(sectorSource, perceptConcat));
    links.push(connect(imuInput, perceptConcat));
    links.push(connect(perceptConcat, perceptNode));
    links.push(connect(perceptNode, decideConcat));
    links.push(connect(poseInput, decideConcat));
    links.push(connect(slipInput, decideConcat));
    links.push(connect(goalInput, decideConcat));
    links.push(connect(decideConcat, decideNode));

    nodes.push(imuInput, poseInput, slipInput, goalInput, perceptConcat, perceptNode, decideConcat, decideNode);
}

// ═══════════════════════════════════════════════════════════════════════════
// Pipeline builder
// ═══════════════════════════════════════════════════════════════════════════

export class PipelineBuilder {
    /**
     * Config A: LiDAR only.
     *
     * ```
     * [lidar_depth] → [convolution] → [percept_cortex] → [decision_cortex]
     * ```
     */
    public static lidarOnly(config: IPipelineConfig): ComputeGraph {
        const nodes: IComputeNode[] = [];
        const links: DataLink[] = [];

        const lidarInput = new ExternalInputNode("lidar_depth", [config.depthBufferHeight, config.depthBufferWidth]);
        const conv = new ConvolutionNode(config.convolution, config.depthBufferWidth, config.depthBufferHeight);

        links.push(connect(lidarInput, conv));
        nodes.push(lidarInput, conv);

        buildPerceptDecisionTail(conv, config, nodes, links);

        return new ComputeGraph(nodes, links);
    }

    /**
     * Config B: Stereo with classical matching (BM/SGM).
     *
     * ```
     * [stereo_depth] → [convolution] → [percept_cortex] → [decision_cortex]
     * ```
     *
     * The stereo matching itself happens outside the graph (in the
     * IStereoDepthProvider). This config consumes the resulting depth buffer.
     */
    public static stereoClassical(config: IPipelineConfig): ComputeGraph {
        const nodes: IComputeNode[] = [];
        const links: DataLink[] = [];

        const stereoInput = new ExternalInputNode("stereo_depth", [config.depthBufferHeight, config.depthBufferWidth]);
        const conv = new ConvolutionNode(config.convolution, config.depthBufferWidth, config.depthBufferHeight);

        links.push(connect(stereoInput, conv));
        nodes.push(stereoInput, conv);

        buildPerceptDecisionTail(conv, config, nodes, links);

        return new ComputeGraph(nodes, links);
    }

    /**
     * Config C: Stereo with learned MatchingCortex.
     *
     * ```
     * [stereo_pair] → [matching_cortex] → [percept_cortex] → [decision_cortex]
     * ```
     *
     * The MatchingCortex replaces both stereo matching AND convolution —
     * it directly outputs sector-resolution depth.
     */
    public static stereoMLP(
        config: IPipelineConfig,
        matchingConfig: IMatchingCortexConfig
    ): ComputeGraph {
        const nodes: IComputeNode[] = [];
        const links: DataLink[] = [];

        const stereoInput = new ExternalInputNode("stereo_pair", [matchingConfig.imageHeight, matchingConfig.imageWidth, 2]);
        const matchingCortex = new MatchingCortexNode(matchingConfig);

        links.push(connect(stereoInput, matchingCortex));
        nodes.push(stereoInput, matchingCortex);

        buildPerceptDecisionTail(matchingCortex, config, nodes, links);

        return new ComputeGraph(nodes, links);
    }

    /**
     * Config D: Fused (stereo + LiDAR).
     *
     * ```
     * [stereo_depth] → [convolution_stereo] ──┐
     *                                           ├──► [fusion] → [percept] → [decision]
     * [lidar_depth]  → [convolution_lidar]  ──┘
     * ```
     */
    public static fused(config: IPipelineConfig): ComputeGraph {
        const nodes: IComputeNode[] = [];
        const links: DataLink[] = [];

        const stereoInput = new ExternalInputNode("stereo_depth", [config.depthBufferHeight, config.depthBufferWidth]);
        const lidarInput = new ExternalInputNode("lidar_depth", [config.depthBufferHeight, config.depthBufferWidth]);

        const convStereo = new ConvolutionNode(config.convolution, config.depthBufferWidth, config.depthBufferHeight);
        convStereo.id = "convolution_stereo";

        const convLidar = new ConvolutionNode(config.convolution, config.depthBufferWidth, config.depthBufferHeight);
        convLidar.id = "convolution_lidar";

        const fusion = new DepthFusionComputeNode(config.convolution.cols * config.convolution.rows);

        links.push(connect(stereoInput, convStereo));
        links.push(connect(lidarInput, convLidar));
        links.push(connect(convStereo, fusion));
        links.push(connect(convLidar, fusion));
        nodes.push(stereoInput, lidarInput, convStereo, convLidar, fusion);

        buildPerceptDecisionTail(fusion, config, nodes, links);

        return new ComputeGraph(nodes, links);
    }
}
