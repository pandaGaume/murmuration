import { GraphNode, IDisposable } from "@spiky-panda/core";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { ILidarEvent, ILidarNode, ILidarScanMetadata, ILidarScanOptions, ILidarScanResult, ISensor, LidarBeams, LidarEncoding } from "@dev/core/perception";
import { ISimSpace } from "@dev/core/simulation";
import { generateId } from "@dev/core/utils";

/**
 * Default lidar scan parameters.
 */
const DEFAULTS = {
    beams: 16 as LidarBeams,
    angularResolution: 1.0,
    encoding: "uint16" as LidarEncoding,
    maxRange: 100,
    hFov: 360,
    vFov: 30,
};

/**
 * Optional configuration for the Babylon lidar adapter.
 */
export interface IBabylonLidarOptions {
    /** Default scan parameters (used by onTick auto-scan). */
    defaults?: Partial<ILidarScanOptions>;

    /** Horizontal field of view in degrees. Default: 360 (spinning lidar). */
    hFov?: number;

    /** Vertical field of view in degrees. Default: 30. */
    vFov?: number;

    /**
     * Optional predicate to filter which meshes are hit by rays.
     * If not provided, all meshes in the scene are candidates.
     */
    pickPredicate?: (mesh: AbstractMesh) => boolean;
}

/**
 * Babylon.js adapter for a lidar sensor using CPU raycasting.
 *
 * Casts rays from a `TransformNode`'s world position in a grid pattern
 * defined by vertical beams and horizontal columns (derived from FOV
 * and angular resolution). Each ray reports the distance to the nearest
 * hit, or 0 if nothing is within range — matching real lidar behavior
 * for sky / out-of-range returns.
 *
 * **Performance note**: CPU raycasting is O(beams × columns × scene triangles).
 * For dense scans (64 beams × 360 columns = 23,040 rays), consider using
 * Babylon's `DepthRenderer` (GPU) for better performance. This adapter
 * prioritizes simplicity and precision over throughput.
 *
 * **Coordinate convention**: the origin's local Z axis is "forward",
 * Y is "up". Horizontal sweep is around Y, vertical sweep tilts away
 * from the XZ plane. This matches Babylon's default coordinate system.
 */
export class BabylonLidarAdapter extends GraphNode implements ILidarNode {
    private _scene: Scene;
    private _origin: TransformNode;
    private _hFov: number;
    private _vFov: number;
    private _scanDefaults: Partial<ILidarScanOptions>;
    private _pickPredicate: ((mesh: AbstractMesh) => boolean) | undefined;

    private _cachedResult: ILidarScanResult = { data: "", metadata: this._emptyMetadata() };
    private _listeners: Array<(src: ISensor, data: ILidarEvent[]) => void> = [];

    /**
     * @param scene   The Babylon.js scene (needed for raycasting).
     * @param origin  The TransformNode defining the lidar's position and orientation.
     * @param options Configuration: FOV, defaults, pick predicate.
     */
    public constructor(scene: Scene, origin: TransformNode, options?: IBabylonLidarOptions) {
        super();
        this.id = generateId("lidar");
        this._scene = scene;
        this._origin = origin;
        this._hFov = options?.hFov ?? DEFAULTS.hFov;
        this._vFov = options?.vFov ?? DEFAULTS.vFov;
        this._scanDefaults = options?.defaults ?? {};
        this._pickPredicate = options?.pickPredicate;
    }

    // -- ISensorReadable<ILidarScanResult> --

    /** Return the cached result from the last auto-scan (onTick). */
    public sensorRead(): ILidarScanResult {
        return this._cachedResult;
    }

    // -- ISensorEventEmitter<ILidarEvent> --

    public onSensorEvent(callback: (src: ISensor, data: ILidarEvent[]) => void): IDisposable {
        this._listeners.push(callback);
        return {
            dispose: () => {
                const idx = this._listeners.indexOf(callback);
                if (idx >= 0) this._listeners.splice(idx, 1);
            },
        };
    }

    // -- ILidarNode --

    /**
     * Perform a lidar scan by casting rays in a beams × columns grid.
     *
     * Each ray is cast from the origin's world position along a direction
     * derived from the origin's orientation, rotated by the beam's vertical
     * angle and the column's horizontal angle.
     */
    public scan(options: ILidarScanOptions): ILidarScanResult {
        const beams: LidarBeams = options.beams ?? DEFAULTS.beams;
        const angularRes = options.angularResolution ?? DEFAULTS.angularResolution;
        const encoding: LidarEncoding = options.encoding ?? DEFAULTS.encoding;
        const maxRange = options.maxRange ?? DEFAULTS.maxRange;

        const columns = Math.floor(this._hFov / angularRes);
        const totalSamples = beams * columns;

        // Allocate depth buffer.
        const isUint16 = encoding === "uint16";
        const buffer = isUint16 ? new Uint16Array(totalSamples) : new Float32Array(totalSamples);

        // Origin world transform.
        const worldMatrix = this._origin.getWorldMatrix();
        const originPos = Vector3.TransformCoordinates(Vector3.Zero(), worldMatrix);

        // Vertical angle range: centered around horizontal plane.
        const vFovRad = (this._vFov * Math.PI) / 180;
        const hStartRad = (-this._hFov / 2) * (Math.PI / 180);

        // Near/far planes (for metadata).
        const nearPlane = 0.1;
        const farPlane = maxRange;

        for (let beam = 0; beam < beams; beam++) {
            // Vertical angle: distribute beams evenly over vertical FOV.
            const vAngle = -vFovRad / 2 + (beam / Math.max(beams - 1, 1)) * vFovRad;

            for (let col = 0; col < columns; col++) {
                // Horizontal angle.
                const hAngle = hStartRad + (col * angularRes * Math.PI) / 180;

                // Compute ray direction in local space, then transform to world.
                const localDir = new Vector3(Math.sin(hAngle) * Math.cos(vAngle), Math.sin(vAngle), Math.cos(hAngle) * Math.cos(vAngle));

                const worldDir = Vector3.TransformNormal(localDir, worldMatrix);
                worldDir.normalize();

                // Cast ray.
                const ray = new Ray(originPos, worldDir, maxRange);
                const hit = this._scene.pickWithRay(ray, this._pickPredicate);

                let depth = 0; // 0 = no return (out of range / sky)
                if (hit?.hit && hit.distance <= maxRange && hit.distance >= nearPlane) {
                    depth = hit.distance;
                }

                // Encode depth value.
                const idx = beam * columns + col;
                if (isUint16) {
                    // Millimeters, clamped to uint16 range.
                    buffer[idx] = Math.min(Math.round(depth * 1000), 65535);
                } else {
                    buffer[idx] = depth;
                }
            }
        }

        // Base64-encode the typed array.
        const bytes = new Uint8Array(buffer.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const data = btoa(binary);

        const metadata: ILidarScanMetadata = {
            beams,
            columns,
            nearPlane,
            farPlane,
            hFov: this._hFov,
            encoding,
        };

        return { data, metadata };
    }

    // -- ISimNode lifecycle --

    /** Auto-scan with default options each tick, cache result, emit event. */
    public onTick(_dtMs: number): void {
        const options: ILidarScanOptions = {
            uri: this._origin.name,
            ...this._scanDefaults,
        };

        this._cachedResult = this.scan(options);

        // Emit to subscribers.
        if (this._listeners.length > 0) {
            const event: ILidarEvent = {
                id: this.id,
                series: [
                    {
                        measurement: { schema: "depth.lidar" },
                        samples: [{ value: this._cachedResult, quality: 192 }],
                    },
                ],
            };
            for (const listener of this._listeners) {
                listener(this, [event]);
            }
        }
    }

    public onAdded(_space: ISimSpace): void {
        // No initialization needed — scene and origin are set in constructor.
    }

    public onRemoved(_space: ISimSpace): void {
        this._listeners.length = 0;
    }

    public override dispose(): void {
        super.dispose();
        this._listeners.length = 0;
    }

    // -- Private --

    private _emptyMetadata(): ILidarScanMetadata {
        return {
            beams: DEFAULTS.beams,
            columns: 0,
            nearPlane: 0.1,
            farPlane: DEFAULTS.maxRange,
            hFov: DEFAULTS.hFov,
            encoding: DEFAULTS.encoding,
        };
    }
}
