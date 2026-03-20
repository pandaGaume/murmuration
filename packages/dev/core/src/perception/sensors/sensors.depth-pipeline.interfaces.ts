// ═══════════════════════════════════════════════════════════════════════════
// Depth pipeline interfaces — DepthBuffer → Convolution → Sector data
//
// Two-stage pipeline for converting high-resolution depth information
// into compact sector-based representations consumed by the PerceptCortex.
//
// Both stages are overridable:
//
// ┌──────────────────────┐
// │ IDepthBufferProvider │  Produces raw depth (high-res)
// │                      │
// │  MathDepthRenderer   │  CPU raycasting (training fallback)
// │  BabylonDepthReader  │  GPU depth buffer via readPixels()
// │  CanvasDepthReader   │  ImageData from 2D canvas
// │  WebGPUDepthReader   │  Compute shader (future)
// └──────────┬───────────┘
//            │ IDepthBuffer (Float32Array, normalized [0,1], W × H)
//            ▼
// ┌──────────────────────┐
// │ IConvolutionProvider │  Downsamples to sector grid
// │                      │
// │  MathConvolution     │  CPU average pooling (default)
// │  GPUConvolution      │  WebGL/WebGPU compute (future)
// │  CanvasConvolution   │  Canvas resize + readback
// └──────────┬───────────┘
//            │ Float32Array (cols × rows, meters)
//            ▼
//       sector depths[]
//
// These interfaces live in core because they are consumed during:
// - Training: MathDepthRenderer → MathConvolution → labels
// - Runtime:  BabylonDepthReader → MathConvolution → PerceptCortex input
// - MCP:      same pipeline for camera_lidar tool
// ═══════════════════════════════════════════════════════════════════════════

// ─── Depth buffer ────────────────────────────────────────────────────────────

/**
 * Raw depth buffer output from any depth source.
 *
 * Values are normalized to [0, 1] where:
 * - 0.0 = near plane
 * - 1.0 = far plane (or sky / no geometry)
 *
 * Row-major, top-to-bottom (matching WebGL readPixels after Y-flip).
 */
export interface IDepthBuffer {
    /** Depth values, length = width × height. */
    data: Float32Array;

    /** Buffer width in pixels. */
    width: number;

    /** Buffer height in pixels. */
    height: number;

    /** Camera near plane distance in meters. */
    near: number;

    /** Camera far plane distance in meters. */
    far: number;
}

/**
 * Produces a raw depth buffer from a scene / scenario.
 *
 * Implementations determine how the depth is generated:
 *
 * - **MathDepthRenderer**: CPU raycasting against axis-aligned primitives.
 *   Used for offline training data generation. No GPU needed.
 *   Produces a virtual depth buffer by casting rays in a grid pattern.
 *
 * - **BabylonDepthReader**: reads `depthRenderer.getDepthMap().readPixels()`
 *   from the Babylon.js engine. GPU-accelerated, handles arbitrary mesh
 *   geometry, terrain, foliage. Used for real-time simulation.
 *
 * - **ThreeJsDepthReader**: uses `WebGLRenderer.readRenderTargetPixels()`
 *   on a depth-only render pass.
 *
 * - **CesiumDepthReader**: reads the globe depth texture for planetary-scale
 *   LiDAR simulation.
 *
 * The `TContext` generic allows framework-specific parameters:
 * - Math: `IScenario` + `IPose`
 * - Babylon: `Camera` + `Scene`
 * - Three.js: `PerspectiveCamera` + `Scene`
 */
export interface IDepthBufferProvider<TContext = unknown> {
    /**
     * Render or compute the depth buffer.
     *
     * @param context     Framework-specific rendering context.
     * @param width       Desired buffer width in pixels.
     * @param height      Desired buffer height in pixels.
     * @returns           Raw depth buffer (sync or async depending on GPU readback).
     */
    render(context: TContext, width: number, height: number): IDepthBuffer | Promise<IDepthBuffer>;
}

// ─── Convolution / downsampling ──────────────────────────────────────────────

/**
 * Configuration for the depth convolution stage.
 */
export interface IConvolutionConfig {
    /** Number of output columns (horizontal sectors). */
    cols: number;

    /** Number of output rows (vertical beams). */
    rows: number;

    /**
     * Pooling strategy for aggregating source pixels within each cell.
     *
     * - `"average"`: mean depth — smooth, good for general perception.
     *   Matches the existing `downsampleDepthGrid()` behavior.
     *
     * - `"min"`: minimum depth — closest obstacle in the cell.
     *   More conservative, better for obstacle detection (never misses
     *   a thin obstacle that averaging might dilute).
     *
     * - `"max"`: maximum depth — farthest point in the cell.
     *   Useful for finding open corridors.
     *
     * Default: `"min"` (safest for navigation — a thin pole at 2m
     * should not be averaged with empty space at 100m).
     */
    pooling: "average" | "min" | "max";

    /**
     * Maximum LiDAR range in meters.
     * Depth values beyond this distance are reported as `maxRange`
     * (no return), matching real LiDAR behavior.
     */
    maxRange: number;
}

/**
 * Downsamples a high-resolution depth buffer into a compact sector grid.
 *
 * This is the "convolution" step — it reduces a W×H depth image into
 * a cols×rows grid where each cell aggregates the source pixels that
 * fall within it, using the configured pooling strategy.
 *
 * Implementations:
 *
 * - **MathConvolution** (default): pure CPU loop. Uses the same algorithm
 *   as `downsampleDepthGrid()` from the MCP project. Fast enough for
 *   real-time at typical grid sizes (36×1 to 128×16).
 *
 * - **GPUConvolution**: WebGL/WebGPU compute shader for very high-res
 *   buffers. Overkill for current grid sizes but useful if the depth
 *   buffer is already on the GPU (avoids CPU readback entirely).
 *
 * - **CanvasConvolution**: uses Canvas 2D `drawImage()` resize trick
 *   followed by `getImageData()`. Leverages browser's optimized bilinear
 *   interpolation. Only works in browser environments.
 */
export interface IConvolutionProvider {
    /**
     * Downsample a depth buffer to a sector grid.
     *
     * @param buffer  Raw depth buffer (normalized [0,1]).
     * @param config  Convolution parameters (cols, rows, pooling, maxRange).
     * @returns       Sector depths in meters, length = cols × rows.
     *                Row-major: `grid[row * cols + col]`.
     */
    downsample(buffer: IDepthBuffer, config: IConvolutionConfig): Float32Array;
}

// ─── Full pipeline ───────────────────────────────────────────────────────────

/**
 * Complete depth-to-sectors pipeline: render → convolve → sector data.
 *
 * Composes an `IDepthBufferProvider` with an `IConvolutionProvider`.
 * Consumers (PerceptCortex input builder, training data generator, MCP tools)
 * call `execute()` and get back ready-to-use sector depths.
 *
 * ```typescript
 * // Training (CPU):
 * const pipeline = new DepthPipeline(
 *     new MathDepthRenderer(),
 *     new MathConvolution()
 * );
 *
 * // Runtime (Babylon GPU):
 * const pipeline = new DepthPipeline(
 *     new BabylonDepthReader(engine, scene),
 *     new MathConvolution()  // convolution is cheap, CPU is fine
 * );
 * ```
 */
export interface IDepthPipeline<TContext = unknown> {
    /** The depth buffer source. */
    readonly depthProvider: IDepthBufferProvider<TContext>;

    /** The downsampling strategy. */
    readonly convolution: IConvolutionProvider;

    /**
     * Execute the full pipeline: render depth → convolve → sector data.
     *
     * @param context   Framework-specific rendering context.
     * @param config    Convolution configuration.
     * @param bufferW   Depth buffer width (default: auto from context).
     * @param bufferH   Depth buffer height (default: auto from context).
     * @returns         Sector depths in meters (length = cols × rows).
     */
    execute(context: TContext, config: IConvolutionConfig, bufferW?: number, bufferH?: number): Float32Array | Promise<Float32Array>;
}
