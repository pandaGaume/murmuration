import { IDisposable } from "@spiky-panda/core";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Scene } from "@babylonjs/core/scene";
import { DepthRenderer } from "@babylonjs/core/Rendering/depthRenderer";
import {
    IConvolutionConfig,
    IConvolutionProvider,
    IDepthBuffer,
    IDepthBufferProvider,
    ILidarEvent,
    ILidarNode,
    ILidarScanMetadata,
    ILidarScanOptions,
    ILidarScanResult,
    ISensor,
    LidarBeams,
    LidarEncoding,
    LidarUnit,
    MathConvolution,
} from "@dev/core/perception";
import { ISimSpace, SimTreeNode } from "@dev/core/simulation";
import { Length, Quantity, Unit } from "@dev/core/math";
import { generateId } from "@dev/core/utils";

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Default lidar scan parameters.
 */
const DEFAULTS = {
    beams: 16 as LidarBeams,
    angularResolution: 1.0,
    maxRange: 100,
};

/**
 * Optional configuration for the Babylon lidar adapter.
 */
export interface IBabylonLidarOptions {
    /** Default scan parameters (used by onTick auto-scan). */
    defaults?: Partial<ILidarScanOptions>;

    /**
     * Override the convolution provider.
     * Default: `MathConvolution` (CPU average/min/max pooling).
     * Can be replaced with a GPU-based implementation.
     */
    convolution?: IConvolutionProvider;

    /**
     * Pooling strategy for downsampling the depth buffer.
     * - `"min"`: closest obstacle per sector (safest for navigation).
     * - `"average"`: mean depth per sector (smoother).
     * - `"max"`: farthest point per sector (corridor detection).
     * Default: `"min"`.
     */
    pooling?: "average" | "min" | "max";
}

/**
 * Babylon.js lidar adapter — **decorator around a Camera**.
 *
 * Wraps a Babylon `Camera` and uses its `DepthRenderer` to read the
 * GPU depth buffer, then downsamples it into a compact sector grid
 * via the `IConvolutionProvider` (default: `MathConvolution`).
 *
 * This follows the same pipeline as the MCP `camera_lidar` tool:
 *
 * ```
 * Camera → DepthRenderer → readPixels() → IDepthBuffer
 *     → IConvolutionProvider.downsample() → Float32Array (meters)
 *         → ILidarScanResult
 * ```
 *
 * **Why decorate a Camera?**
 * - The depth buffer IS a dense LiDAR scan — the GPU already solved
 *   ray-triangle intersection for every pixel via rasterization.
 * - No CPU raycasting needed. O(1) per frame regardless of scene complexity.
 * - FOV, near/far planes, position, orientation — all come from the Camera.
 * - Multiple LiDAR configurations can share the same Camera's depth buffer,
 *   just with different convolution parameters.
 *
 * **Performance**: reading the GPU depth buffer is async (readPixels).
 * The adapter caches the last result for synchronous `sensorRead()` access,
 * and updates it each `onTick()`.
 *
 * Implements `IDepthBufferProvider` so it can also be plugged into the
 * training pipeline for validation against GPU-rendered scenes.
 */
export class BabylonLidarAdapter extends SimTreeNode implements ILidarNode, IDepthBufferProvider<Camera> {
    private readonly _scene: Scene;
    private readonly _camera: Camera;
    private readonly _convolution: IConvolutionProvider;
    private readonly _pooling: "average" | "min" | "max";
    private readonly _scanDefaults: Partial<ILidarScanOptions>;

    private _depthRenderer: DepthRenderer | null = null;
    private _cachedResult: ILidarScanResult = { data: new Float32Array(0), metadata: this._emptyMetadata() };
    private _listeners: Array<(src: ISensor, data: ILidarEvent[]) => void> = [];
    private _pendingScan = false;

    /**
     * @param scene   The Babylon.js scene.
     * @param camera  The Camera to decorate. Its depth buffer provides the LiDAR data.
     * @param options Configuration: defaults, convolution provider, pooling strategy.
     */
    public constructor(scene: Scene, camera: Camera, options?: IBabylonLidarOptions) {
        super();
        this.id = generateId("lidar");
        this._scene = scene;
        this._camera = camera;
        this._convolution = options?.convolution ?? new MathConvolution();
        this._pooling = options?.pooling ?? "min";
        this._scanDefaults = options?.defaults ?? {};
    }

    /** The decorated Camera. */
    public get camera(): Camera {
        return this._camera;
    }

    // ── IDepthBufferProvider<Camera> ──────────────────────────────────────

    /**
     * Read the Camera's GPU depth buffer as an `IDepthBuffer`.
     *
     * Enables the scene's `DepthRenderer` for this camera, renders one
     * frame, reads back the depth texture, and returns normalized [0,1]
     * depth values.
     */
    public async render(_context: Camera, width: number, height: number): Promise<IDepthBuffer> {
        return this._readDepthBuffer(width, height);
    }

    // ── ISensorReadable<ILidarScanResult> ────────────────────────────────

    /** Return the cached result from the last auto-scan (onTick). */
    public sensorRead(): ILidarScanResult {
        return this._cachedResult;
    }

    // ── ISensorEventEmitter<ILidarEvent> ─────────────────────────────────

    public onSensorEvent(callback: (src: ISensor, data: ILidarEvent[]) => void): IDisposable {
        this._listeners.push(callback);
        return {
            dispose: () => {
                const idx = this._listeners.indexOf(callback);
                if (idx >= 0) this._listeners.splice(idx, 1);
            },
        };
    }

    // ── ILidarNode ───────────────────────────────────────────────────────

    /**
     * Perform a lidar scan using the Camera's GPU depth buffer.
     *
     * **Pipeline**:
     * 1. Enable DepthRenderer for the camera (lazy, one-time).
     * 2. Render the scene to produce the depth texture.
     * 3. Read the depth texture via `readPixels()`.
     * 4. Flip vertically (WebGL readPixels is bottom-to-top).
     * 5. Downsample via `IConvolutionProvider` → sector grid in meters.
     *
     * Note: this method is synchronous per the `ILidarNode` interface,
     * so it uses the last rendered depth buffer. Call after the scene
     * has rendered at least once. For async access with fresh render,
     * use `scanAsync()`.
     */
    public scan(options: ILidarScanOptions): ILidarScanResult {
        // Synchronous: return cached result (updated by onTick).
        // The cached result already uses the latest scan parameters.
        return this._cachedResult;
    }

    /**
     * Async scan with fresh GPU depth buffer read.
     *
     * Use this when you need guaranteed fresh data (e.g., from MCP tools).
     * For real-time simulation, `onTick()` handles the update cycle.
     */
    public async scanAsync(options: ILidarScanOptions): Promise<ILidarScanResult> {
        const beams: LidarBeams = options.beams ?? DEFAULTS.beams;
        const angularRes = options.angularResolution ?? DEFAULTS.angularResolution;
        const maxRange = options.maxRange ?? DEFAULTS.maxRange;
        const encoding: LidarEncoding = options.encoding ?? "float32";

        // Resolve the scene's length unit from the ISimSpace context.
        // The depth buffer values are in scene units (whatever the camera
        // near/far planes are set to). We need to know what unit that is
        // to produce correctly labeled output.
        const sceneUnit = this.space?.context?.units?.length ?? Length.Units.m;

        // Compute grid dimensions from camera FOV and angular resolution
        const engine = this._scene.getEngine();
        const vFovRad = this._camera.fov;
        const aspectRatio = engine.getAspectRatio(this._camera);
        const hFovDeg = 2 * Math.atan(Math.tan(vFovRad / 2) * aspectRatio) * RAD_TO_DEG;
        const columns = Math.max(1, Math.floor(hFovDeg / angularRes));

        // Read GPU depth buffer
        const depthBuffer = await this._readDepthBuffer(columns, beams);

        // Downsample via convolution → Float32Array in scene units
        const convConfig: IConvolutionConfig = {
            cols: columns,
            rows: beams,
            pooling: this._pooling,
            maxRange,
        };

        const sceneUnitGrid = this._convolution.downsample(depthBuffer, convConfig);

        // Convert to requested encoding, using the scene's length unit
        const { data, unit } = this._encodeDepths(sceneUnitGrid, encoding, maxRange, sceneUnit);

        const metadata: ILidarScanMetadata = {
            beams,
            columns,
            nearPlane: this._camera.minZ,
            farPlane: this._camera.maxZ,
            hFov: hFovDeg,
            angularResolution: angularRes,
            maxRange,
            encoding,
            unit,
        };

        return { data, metadata };
    }

    // ── ISimNode lifecycle ───────────────────────────────────────────────

    /**
     * Each tick: request an async depth buffer read.
     * The result is cached for synchronous `sensorRead()` / `scan()` access.
     */
    protected override onSelfTick(_dtMs: number): void {
        if (this._pendingScan) return; // don't stack async reads
        this._pendingScan = true;

        const options: ILidarScanOptions = {
            uri: this._camera.name,
            ...this._scanDefaults,
        };

        this.scanAsync(options).then((result) => {
            this._cachedResult = result;
            this._pendingScan = false;

            // Emit to subscribers
            if (this._listeners.length > 0) {
                const event: ILidarEvent = {
                    id: this.id,
                    series: [
                        {
                            measurement: { schema: "depth.lidar" },
                            samples: [{ value: result, quality: 192 }],
                        },
                    ],
                };
                for (const listener of this._listeners) {
                    listener(this, [event]);
                }
            }
        });
    }

    protected override onSelfAdded(_space: ISimSpace): void {
        // Enable depth renderer lazily on first use
        this._depthRenderer = this._scene.enableDepthRenderer(this._camera);
    }

    protected override onSelfRemoved(_space: ISimSpace): void {
        this._listeners.length = 0;
        this._depthRenderer = null;
    }

    public override dispose(): void {
        super.dispose();
        this._listeners.length = 0;
        this._depthRenderer = null;
    }

    // ── Private ──────────────────────────────────────────────────────────

    /**
     * Read the GPU depth buffer, flip vertically, return as IDepthBuffer.
     * Matches the pipeline from the MCP camera adapter's `_readLidarAsync`.
     */
    private async _readDepthBuffer(_requestedW: number, _requestedH: number): Promise<IDepthBuffer> {
        if (!this._depthRenderer) {
            this._depthRenderer = this._scene.enableDepthRenderer(this._camera);
        }

        // Ensure scene is rendered with latest camera state
        this._scene.render();

        const depthMap = this._depthRenderer.getDepthMap();
        const rawDepth = await depthMap.readPixels();
        if (!rawDepth) {
            throw new Error("readPixels returned null for depth buffer");
        }

        const depthW = depthMap.getRenderWidth();
        const depthH = depthMap.getRenderHeight();
        const pixelCount = depthW * depthH;

        // Extract single-channel depth from potentially multi-channel output
        const rawArr = rawDepth instanceof Float32Array
            ? rawDepth
            : new Float32Array(rawDepth.buffer, rawDepth.byteOffset, rawDepth.byteLength / 4);

        const stride = rawArr.length / pixelCount;
        const depthBuffer = new Float32Array(pixelCount);

        if (stride >= 4) {
            for (let i = 0; i < pixelCount; i++) {
                depthBuffer[i] = rawArr[i * stride];
            }
        } else {
            depthBuffer.set(rawArr.subarray(0, pixelCount));
        }

        // Flip vertically (WebGL readPixels returns bottom-to-top)
        const flipped = new Float32Array(pixelCount);
        for (let y = 0; y < depthH; y++) {
            flipped.set(
                depthBuffer.subarray((depthH - 1 - y) * depthW, (depthH - y) * depthW),
                y * depthW
            );
        }

        return {
            data: flipped,
            width: depthW,
            height: depthH,
            near: this._camera.minZ,
            far: this._camera.maxZ,
        };
    }

    /**
     * Convert depth values from scene units to hardware output format.
     *
     * The GPU depth buffer and convolution produce values in **scene units**
     * (whatever `ISimSpace.context.units.length` is — could be m, cm, km).
     * This method converts them to the fixed hardware conventions:
     *
     * - `"float32"`: scene units → **meters** as Float32Array.
     *   Always meters, matching standard SI convention for LiDAR data.
     *
     * - `"uint16"`: scene units → **millimeters** as Uint16Array.
     *   Matches real LiDAR hardware (Velodyne, SICK). Clamped to 0–65535.
     *
     * Both: out-of-range → 0 (no return).
     *
     * @param grid       Depth values in scene units.
     * @param encoding   Requested output encoding.
     * @param maxRange   Maximum range in scene units.
     * @param sceneUnit  The scene's length Unit (from `space.context.units.length`).
     */
    private _encodeDepths(
        grid: Float32Array,
        encoding: LidarEncoding,
        maxRange: number,
        sceneUnit: Unit
    ): { data: Float32Array | Uint16Array; unit: LidarUnit } {
        // Precompute conversion factor only if scene unit differs from target.
        // Common case (scene in meters): factor = 1, no conversion overhead.
        const targetUnit = encoding === "uint16" ? Length.Units.mm : Length.Units.m;
        const factor = sceneUnit === targetUnit ? 1 : Quantity.Convert(1, sceneUnit, targetUnit);
        const needsConvert = factor !== 1;

        if (encoding === "uint16") {
            const u16 = new Uint16Array(grid.length);
            for (let i = 0; i < grid.length; i++) {
                const v = grid[i];
                if (v <= 0 || v > maxRange) {
                    u16[i] = 0;
                } else {
                    u16[i] = Math.min(Math.round(needsConvert ? v * factor : v), 65535);
                }
            }
            return { data: u16, unit: "mm" };
        }

        const f32 = new Float32Array(grid.length);
        if (needsConvert) {
            for (let i = 0; i < grid.length; i++) {
                const v = grid[i];
                f32[i] = v <= 0 || v > maxRange ? 0 : v * factor;
            }
        } else {
            for (let i = 0; i < grid.length; i++) {
                const v = grid[i];
                f32[i] = v <= 0 || v > maxRange ? 0 : v;
            }
        }
        return { data: f32, unit: "m" };
    }

    private _emptyMetadata(): ILidarScanMetadata {
        return {
            beams: DEFAULTS.beams,
            columns: 0,
            nearPlane: 0.1,
            farPlane: DEFAULTS.maxRange,
            hFov: 0,
            angularResolution: DEFAULTS.angularResolution,
            maxRange: DEFAULTS.maxRange,
            encoding: "float32",
            unit: "m",
        };
    }
}
