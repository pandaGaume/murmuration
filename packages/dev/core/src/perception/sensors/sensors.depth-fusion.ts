// ═══════════════════════════════════════════════════════════════════════════
// DepthFusionNode — fuses stereo and LiDAR depth sources
//
// Selects the best depth source based on operating conditions:
// - Day + good texture → stereo (passive, low power)
// - Night / low texture / stereo unhealthy → LiDAR (active, reliable)
// - Both available → stereo primary, LiDAR for validation
//
// Outputs a unified IDepthBuffer through the standard depth pipeline,
// so all downstream processing (convolution → PerceptCortex) is
// source-agnostic.
//
// Mimics real Mars rover strategy: NavCams (stereo) for daily driving,
// LiDAR/SuperCam only when needed.
// ═══════════════════════════════════════════════════════════════════════════

import { IDisposable } from "@spiky-panda/core";
import { ISimSpace, SimTreeNode } from "@dev/core/simulation";
import { IConvolutionConfig, IConvolutionProvider, IDepthBuffer } from "./sensors.depth-pipeline.interfaces";
import { MathConvolution } from "./sensors.depth-pipeline";
import { ISensor, ISensorEventEmitter, ISensorNode, ISensorReadable } from "./sensors.interfaces";
import { ILidarNode } from "./sensors.lidar.interfaces";
import { IStereoNode } from "./sensors.stereo.interfaces";
import { IRecord } from "@dev/core/telemetry";
import { generateId } from "@dev/core/utils";

// ─── Depth source selection ──────────────────────────────────────────────────

/**
 * Active depth source at any given moment.
 */
export type DepthSourceType = "stereo" | "lidar" | "none";

/**
 * Policy for choosing between stereo and LiDAR.
 */
export interface IDepthFusionPolicy {
    /**
     * Determine which depth source to use.
     *
     * @param stereoHealthy  Whether stereo has sufficient light/texture.
     * @param lidarAvailable Whether LiDAR is connected and functional.
     * @returns              Which source to activate.
     */
    select(stereoHealthy: boolean, lidarAvailable: boolean): DepthSourceType;
}

/**
 * Default fusion policy: stereo when healthy, LiDAR as fallback.
 */
export class DefaultFusionPolicy implements IDepthFusionPolicy {
    public select(stereoHealthy: boolean, lidarAvailable: boolean): DepthSourceType {
        if (stereoHealthy) return "stereo";
        if (lidarAvailable) return "lidar";
        return "none";
    }
}

// ─── Fused depth result ──────────────────────────────────────────────────────

/**
 * Unified depth result from the fusion node.
 */
export interface IFusedDepthResult {
    /** Sector depths in scene units. Length = cols × rows. */
    sectors: Float32Array;

    /** Which source produced this result. */
    source: DepthSourceType;

    /** Confidence estimate [0, 1]. Stereo confidence or 1.0 for LiDAR. */
    confidence: number;
}

export interface IFusedDepthEvent extends IRecord<IFusedDepthResult> {}

// ─── Fusion node options ─────────────────────────────────────────────────────

export interface IDepthFusionOptions {
    /** Convolution provider for downsampling depth buffers. Default: MathConvolution. */
    convolution?: IConvolutionProvider;

    /** Convolution config: output grid dimensions and pooling. */
    convolutionConfig: IConvolutionConfig;

    /** Fusion policy. Default: stereo-first, LiDAR fallback. */
    policy?: IDepthFusionPolicy;
}

// ═══════════════════════════════════════════════════════════════════════════
// DepthFusionNode
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fuses stereo and LiDAR depth sources into a single unified output.
 *
 * Lives in the simulation tree as a parent of its sensor children.
 * The stereo and LiDAR nodes are added as children via `addChild()`,
 * so their lifecycle (onTick, onAdded, onRemoved) is propagated
 * automatically by `SimTreeNode`.
 *
 * **Usage:**
 * ```typescript
 * const stereo = new BabylonStereoAdapter(leftCam, rightCam, stereoConfig);
 * const lidar = new BabylonLidarAdapter(scene, navCam);
 *
 * const fusion = new DepthFusionNode(stereo, lidar, {
 *     convolutionConfig: { cols: 36, rows: 1, pooling: "min", maxRange: 100 },
 * });
 *
 * rover.addChild(fusion);
 * // fusion.sensorRead() → IFusedDepthResult with sectors + source info
 * ```
 *
 * **Power management:**
 * When stereo is healthy, the fusion node can signal the LiDAR to
 * reduce its scan rate or enter standby — saving power for the
 * battery-constrained rover.
 */
export class DepthFusionNode extends SimTreeNode implements ISensorNode, ISensorReadable<IFusedDepthResult>, ISensorEventEmitter<IFusedDepthEvent> {
    private readonly _stereo: IStereoNode | null;
    private readonly _lidar: ILidarNode | null;
    private readonly _convolution: IConvolutionProvider;
    private readonly _convConfig: IConvolutionConfig;
    private readonly _policy: IDepthFusionPolicy;

    private _cachedResult: IFusedDepthResult = {
        sectors: new Float32Array(0),
        source: "none",
        confidence: 0,
    };
    private _listeners: Array<(src: ISensor, data: IFusedDepthEvent[]) => void> = [];
    private _activeSource: DepthSourceType = "none";

    /**
     * @param stereo  Stereo depth sensor (nullable — LiDAR-only configs are valid).
     * @param lidar   LiDAR depth sensor (nullable — stereo-only configs are valid).
     * @param options Convolution config, policy, and optional overrides.
     */
    public constructor(stereo: IStereoNode | null, lidar: ILidarNode | null, options: IDepthFusionOptions) {
        super();
        this.id = generateId("depth-fusion");

        this._stereo = stereo;
        this._lidar = lidar;
        this._convolution = options.convolution ?? new MathConvolution();
        this._convConfig = options.convolutionConfig;
        this._policy = options.policy ?? new DefaultFusionPolicy();

        // Add sensors as children — lifecycle auto-propagated by SimTreeNode
        if (stereo) this.addChild(stereo as unknown as SimTreeNode);
        if (lidar) this.addChild(lidar as unknown as SimTreeNode);
    }

    /** Currently active depth source. */
    public get activeSource(): DepthSourceType {
        return this._activeSource;
    }

    // ── ISensorReadable<IFusedDepthResult> ───────────────────────────────

    public sensorRead(): IFusedDepthResult {
        return this._cachedResult;
    }

    // ── ISensorEventEmitter<IFusedDepthEvent> ────────────────────────────

    public onSensorEvent(callback: (src: ISensor, data: IFusedDepthEvent[]) => void): IDisposable {
        this._listeners.push(callback);
        return {
            dispose: () => {
                const idx = this._listeners.indexOf(callback);
                if (idx >= 0) this._listeners.splice(idx, 1);
            },
        };
    }

    // ── SimTreeNode lifecycle ────────────────────────────────────────────

    protected override onSelfTick(_dtMs: number): void {
        // Children (stereo, lidar) have already been ticked by SimTreeNode.
        // We now fuse their latest readings.

        const stereoHealthy = this._stereo?.isHealthy ?? false;
        const lidarAvailable = this._lidar !== null;

        this._activeSource = this._policy.select(stereoHealthy, lidarAvailable);

        let sectors: Float32Array;
        let confidence: number;

        switch (this._activeSource) {
            case "stereo": {
                const scan = this._stereo!.scan();
                sectors = this._depthToSectors(scan.data, scan.metadata.imageWidth, scan.metadata.imageHeight);
                confidence = scan.metadata.averageConfidence;
                break;
            }
            case "lidar": {
                const scan = this._lidar!.sensorRead();
                // LiDAR already produces sector-ready data, but we may need
                // to re-grid if dimensions differ from our convolution config
                if (scan.data.length === this._convConfig.cols * this._convConfig.rows) {
                    sectors = scan.data instanceof Float32Array ? scan.data : new Float32Array(scan.data);
                } else {
                    sectors = this._depthToSectors(scan.data instanceof Float32Array ? scan.data : new Float32Array(scan.data), scan.metadata.columns, scan.metadata.beams);
                }
                confidence = 1.0; // LiDAR is always high confidence when available
                break;
            }
            default:
                sectors = new Float32Array(this._convConfig.cols * this._convConfig.rows);
                confidence = 0;
                break;
        }

        this._cachedResult = {
            sectors,
            source: this._activeSource,
            confidence,
        };

        // Emit to subscribers
        if (this._listeners.length > 0) {
            const event: IFusedDepthEvent = {
                id: this.id,
                series: [
                    {
                        measurement: { schema: "depth.fused" },
                        samples: [{ value: this._cachedResult, quality: Math.round(confidence * 255) }],
                    },
                ],
            };
            for (const listener of this._listeners) {
                listener(this, [event]);
            }
        }
    }

    protected override onSelfRemoved(_space: ISimSpace): void {
        this._listeners.length = 0;
    }

    public override dispose(): void {
        this._listeners.length = 0;
        super.dispose();
    }

    // ── Private ──────────────────────────────────────────────────────────

    /**
     * Downsample a raw depth array to sector grid via the convolution provider.
     */
    private _depthToSectors(data: Float32Array, width: number, height: number): Float32Array {
        // Build an IDepthBuffer from raw data (assume already normalized or in scene units)
        const buffer: IDepthBuffer = {
            data,
            width,
            height,
            near: 0,
            far: this._convConfig.maxRange,
        };
        return this._convolution.downsample(buffer, this._convConfig);
    }
}
