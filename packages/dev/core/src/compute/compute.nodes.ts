// ═══════════════════════════════════════════════════════════════════════════
// Built-in compute nodes for the navigation pipeline
//
// Each node wraps an existing processing stage as an IComputeNode,
// making it pluggable into configurable compute graphs.
//
// Source nodes: read from sensors or external inputs
// Transform nodes: process tensors (convolution, MLP inference, fusion)
// ═══════════════════════════════════════════════════════════════════════════

import { GraphNode } from "@spiky-panda/core";
import { IComputeNode, ITensor } from "@dev/spiky-panda/compute";
import {
    IConvolutionConfig,
    IConvolutionProvider,
    IDepthBuffer,
    MathConvolution,
} from "@dev/core/perception";

// ─── Abstract base ───────────────────────────────────────────────────────────

/**
 * Base class for compute nodes. Extends GraphNode for graph compatibility.
 */
export abstract class ComputeNodeBase extends GraphNode implements IComputeNode {
    public abstract readonly nodeType: string;
    public abstract readonly outputShapes: number[][];
    public abstract execute(inputs: ITensor[]): ITensor[];
}

// ─── Source nodes ────────────────────────────────────────────────────────────

/**
 * External input node — receives tensors from the graph's run() call.
 * Acts as a named injection point for sensor data, pose, goal, etc.
 */
export class ExternalInputNode extends ComputeNodeBase {
    public readonly nodeType = "external_input";
    public readonly outputShapes: number[][];

    private _shape: number[];
    private _name: string;

    constructor(name: string, shape: number[]) {
        super();
        this.id = name;
        this._name = name;
        this._shape = shape;
        this.outputShapes = [shape];
    }

    public execute(inputs: ITensor[]): ITensor[] {
        // External inputs are injected by the graph engine via run()
        if (inputs.length > 0) {
            return [{ ...inputs[0], name: this._name }];
        }
        // Return zeros if no input provided
        const size = this._shape.reduce((a, b) => a * b, 1);
        return [{ data: new Float32Array(size), shape: this._shape, name: this._name }];
    }
}

// ─── Transform nodes ─────────────────────────────────────────────────────────

/**
 * Convolution node — downsamples a depth buffer tensor to a sector grid.
 * Wraps IConvolutionProvider.
 */
export class ConvolutionNode extends ComputeNodeBase {
    public readonly nodeType = "convolution";
    public readonly outputShapes: number[][];

    private readonly _convolution: IConvolutionProvider;
    private readonly _config: IConvolutionConfig;
    private readonly _inputWidth: number;
    private readonly _inputHeight: number;

    constructor(
        config: IConvolutionConfig,
        inputWidth: number,
        inputHeight: number,
        convolution?: IConvolutionProvider
    ) {
        super();
        this.id = "convolution";
        this._config = config;
        this._inputWidth = inputWidth;
        this._inputHeight = inputHeight;
        this._convolution = convolution ?? new MathConvolution();
        this.outputShapes = [[config.cols * config.rows]];
    }

    public execute(inputs: ITensor[]): ITensor[] {
        if (inputs.length === 0) {
            return [{ data: new Float32Array(this._config.cols * this._config.rows), shape: this.outputShapes[0], name: "sectors" }];
        }

        const depthBuffer: IDepthBuffer = {
            data: inputs[0].data,
            width: this._inputWidth,
            height: this._inputHeight,
            near: 0.1,
            far: this._config.maxRange,
        };

        const sectors = this._convolution.downsample(depthBuffer, this._config);
        return [{ data: sectors, shape: [sectors.length], name: "sectors" }];
    }
}

/**
 * MLP inference node — runs a spiky-panda MLP and outputs the result.
 * Wraps any evaluate(input: number[]): number[] function.
 */
export class MLPNode extends ComputeNodeBase {
    public readonly nodeType: string;
    public readonly outputShapes: number[][];

    private readonly _evaluate: (input: number[]) => number[];
    private readonly _outputName: string;

    constructor(
        nodeType: string,
        _inputSize: number,
        outputSize: number,
        evaluate: (input: number[]) => number[],
        outputName: string = "output"
    ) {
        super();
        this.id = nodeType;
        this.nodeType = nodeType;
        this._evaluate = evaluate;
        this._outputName = outputName;
        this.outputShapes = [[outputSize]];
    }

    public execute(inputs: ITensor[]): ITensor[] {
        // Concatenate all input tensors into a single flat array
        let totalLen = 0;
        for (const t of inputs) totalLen += t.data.length;

        const flat = new Float32Array(totalLen);
        let offset = 0;
        for (const t of inputs) {
            flat.set(t.data, offset);
            offset += t.data.length;
        }

        const result = this._evaluate(Array.from(flat));
        return [{ data: new Float32Array(result), shape: [result.length], name: this._outputName }];
    }
}

/**
 * Concatenation node — merges multiple input tensors into one flat vector.
 */
export class ConcatNode extends ComputeNodeBase {
    public readonly nodeType = "concat";
    public readonly outputShapes: number[][];

    private readonly _totalSize: number;
    private readonly _outputName: string;

    constructor(inputSizes: number[], outputName: string = "concat") {
        super();
        this.id = outputName;
        this._totalSize = inputSizes.reduce((a, b) => a + b, 0);
        this._outputName = outputName;
        this.outputShapes = [[this._totalSize]];
    }

    public execute(inputs: ITensor[]): ITensor[] {
        const flat = new Float32Array(this._totalSize);
        let offset = 0;
        for (const t of inputs) {
            flat.set(t.data, offset);
            offset += t.data.length;
        }
        return [{ data: flat, shape: [this._totalSize], name: this._outputName }];
    }
}

/**
 * Depth fusion node — selects the best depth tensor based on confidence.
 * Expects pairs of (depth, confidence) inputs.
 */
export class DepthFusionComputeNode extends ComputeNodeBase {
    public readonly nodeType = "depth_fusion";
    public readonly outputShapes: number[][];

    private readonly _sectorCount: number;

    constructor(sectorCount: number) {
        super();
        this.id = "depth_fusion";
        this._sectorCount = sectorCount;
        this.outputShapes = [[sectorCount]];
    }

    public execute(inputs: ITensor[]): ITensor[] {
        if (inputs.length === 0) {
            return [{ data: new Float32Array(this._sectorCount), shape: [this._sectorCount], name: "fused_depth" }];
        }

        // Simple strategy: use the first input with non-zero data,
        // preferring earlier inputs (stereo before lidar)
        for (const input of inputs) {
            let hasData = false;
            for (let i = 0; i < input.data.length; i++) {
                if (input.data[i] > 0) { hasData = true; break; }
            }
            if (hasData) {
                return [{ data: input.data, shape: [input.data.length], name: "fused_depth" }];
            }
        }

        return [{ data: new Float32Array(this._sectorCount), shape: [this._sectorCount], name: "fused_depth" }];
    }
}
