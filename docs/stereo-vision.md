# Stereo Vision — Algorithm, Trade-offs & Limitations

## Principle

Stereoscopic depth estimation recovers 3D structure from two 2D images
taken from slightly offset viewpoints, the same principle as human binocular
vision. The horizontal displacement (disparity) between corresponding points
in the left and right images is inversely proportional to depth:

```
depth = baseline × focalLength / disparity
```

Where:

- `baseline` = distance between the two camera optical centers (meters)
- `focalLength` = camera focal length in pixels
- `disparity` = horizontal pixel offset between the same point in left vs right image

## Pipeline

```
Left image ──┐                    ┌── Right image
             ▼                    ▼
      ┌─────────────────────────────────┐
      │  1. Rectification                │
      │     Warp both images so that     │
      │     epipolar lines are horizontal│
      │     (corresponding points are    │
      │     on the same scanline)        │
      └──────────────┬──────────────────┘
                     ▼
      ┌─────────────────────────────────┐
      │  2. Stereo Matching              │
      │     For each pixel in the left   │
      │     image, find the best match   │
      │     in the right image along     │
      │     the same scanline            │
      └──────────────┬──────────────────┘
                     ▼
      ┌─────────────────────────────────┐
      │  3. Disparity Map                │
      │     Per-pixel horizontal offset  │
      │     (0 = no match, higher =      │
      │     closer object)               │
      └──────────────┬──────────────────┘
                     ▼
      ┌─────────────────────────────────┐
      │  4. Depth Conversion             │
      │     depth = B × f / disparity    │
      │     → IDepthBuffer [0, 1]        │
      └──────────────┬──────────────────┘
                     ▼
      ┌─────────────────────────────────┐
      │  5. Convolution                  │
      │     Downsample to sector grid    │
      │     (same pipeline as LiDAR)     │
      └─────────────────────────────────┘
```

## Matching Algorithms

### Block Matching (BM)

The simplest approach. For each pixel in the left image, slide a small
window (e.g., 9×9 pixels) along the same scanline in the right image
and find the position that minimizes the Sum of Absolute Differences (SAD)
or Sum of Squared Differences (SSD).

**Complexity**: O(W × H × D × B²) where D = disparity range, B = block size.

| Pro                           | Con                                   |
| ----------------------------- | ------------------------------------- |
| Fast, simple to implement     | Noisy, blocky artifacts               |
| Parallelizable (GPU-friendly) | Fails on textureless surfaces         |
| Low memory footprint          | Sensitive to lighting differences     |
|                               | Poor at depth discontinuities (edges) |

### Semi-Global Matching (SGM)

Aggregates matching costs along multiple directions (typically 8 or 16 paths)
using dynamic programming. Enforces spatial smoothness while preserving
depth discontinuities at object boundaries.

**Complexity**: O(W × H × D × P) where P = number of paths (8 or 16).

| Pro                                      | Con                                |
| ---------------------------------------- | ---------------------------------- |
| Much better quality than BM              | 3–10× slower than BM               |
| Handles depth discontinuities            | Higher memory (cost volume)        |
| Industry standard (automotive, robotics) | Still fails on textureless regions |
| Good balance speed/quality               | Requires parameter tuning          |

### CNN-based Matching (planned)

Convolutional neural networks (e.g., PSMNet, RAFT-Stereo, AANet) learn
to match from data. Significantly better on difficult cases (reflections,
thin structures, repetitive patterns). The CNN architecture is under
development in `spiky-panda-ext` and will be integrated as a
`MatchingCNN` compute node in the configurable pipeline
(`PipelineBuilder.stereoCNN()`).

**Why CNN over MLP?** Stereo matching is fundamentally a 2D spatial
correlation problem — convolutional layers preserve spatial structure
(neighboring pixels matter), whereas an MLP on flattened patches destroys
the 2D topology. CNNs also share weights across spatial positions,
making them far more parameter-efficient for image-to-image tasks.

## Pros vs LiDAR

| Aspect                 | Stereo                                       | LiDAR                                |
| ---------------------- | -------------------------------------------- | ------------------------------------ |
| **Power consumption**  | Very low (2 passive cameras)                 | High (active laser emitter)          |
| **Moving parts**       | None                                         | Rotating mirror (mechanical) or MEMS |
| **Failure modes**      | Lens contamination                           | Laser degradation, motor failure     |
| **Depth density**      | Dense (every pixel)                          | Sparse (beams × columns)             |
| **Color/texture info** | Yes (RGB bonus)                              | No                                   |
| **Range accuracy**     | ±1–5% of depth                               | ±2 mm constant                       |
| **Max range**          | Limited by baseline & resolution (~50–100 m) | 100–300 m typical                    |
| **Night operation**    | No (needs ambient light)                     | Yes (active illumination)            |
| **Cost**               | Low (2 COTS cameras)                         | High (precision optics + laser)      |

## Limitations & Failure Modes

### 1. Textureless surfaces

**Problem**: Block/SGM matching needs visual texture to find correspondences.
A flat white wall, uniform sand, or clear sky has no distinguishing features —
the matching window looks the same everywhere.

**Result**: Disparity = 0 (no match) or random noise.

**Mitigation**: Confidence map flags these regions. The `DepthFusionNode`
falls back to LiDAR when stereo confidence drops.

### 2. Repetitive patterns

**Problem**: Regular patterns (tiles, brick walls, fences) produce multiple
equally good matches along the scanline. The matcher picks one, but it may
be wrong.

**Result**: Incorrect depth values, often appearing as "staircasing" artifacts.

**Mitigation**: SGM's multi-path smoothness constraint reduces this. Larger
block sizes help but reduce detail.

### 3. Occlusions

**Problem**: Regions visible to one camera but hidden from the other (behind
a foreground object). There is no corresponding point to match.

**Result**: Invalid disparity at object boundaries. Typically shows as a
"shadow" of missing depth next to foreground objects.

**Mitigation**: Left-right consistency check — compute disparity from both
directions and mark inconsistent pixels as occluded.

### 4. Depth-proportional noise

**Problem**: Stereo depth accuracy degrades quadratically with distance.
At close range, a 1-pixel disparity error is small. At far range, the same
1-pixel error maps to meters of depth uncertainty.

```
depth_error ≈ depth² / (baseline × focalLength)
```

For a 0.42 m baseline with 500 px focal length:

- At 5 m: ±0.05 m error (1%)
- At 20 m: ±0.8 m error (4%)
- At 50 m: ±5 m error (10%)

**Mitigation**: Use longer baseline (but increases minimum detection range).
Fuse with LiDAR for far-range precision.

### 5. Lighting sensitivity

**Problem**: Different illumination between left/right cameras (shadows,
specular reflections) breaks the brightness constancy assumption that
matching relies on.

**Result**: False matches in areas with strong lighting gradients.

**Mitigation**: Use Census transform or normalized cross-correlation instead
of raw SAD/SSD. These are more robust to illumination changes.

### 6. Minimum range blind spot

**Problem**: Very close objects produce disparities larger than the search
range (`maxDisparity`). Also, objects closer than the baseline have extreme
parallax — they may only be visible to one camera.

**Result**: No depth for objects within `minDepth = baseline × focalLength / maxDisparity`.

For a 0.42 m baseline: minimum reliable range ≈ 1.6 m with 128 px max disparity.

**Mitigation**: Increase `maxDisparity` (costs more computation) or use a
short-baseline stereo pair for near-field.

### 7. Calibration drift

**Problem**: Mechanical vibration, thermal expansion, or impact can shift the
cameras relative to each other. Even sub-pixel misalignment degrades the
rectification, causing matching to fail across the entire image.

**Result**: Systematic depth bias or complete matching failure.

**Mitigation**: Periodic recalibration using known targets. Online
self-calibration from feature tracking.

## Simulation Model

The training package (`scenario.stereo.ts`) simulates stereo depth with:

- **Ideal depth** from raycasting (left camera viewpoint)
- **Depth-proportional Gaussian noise** (`depthNoise` parameter, default 2%)
  mimicking the quadratic error growth
- **Random dropout** (`dropoutRate` parameter, default 3%) mimicking
  textureless/occluded regions where matching fails
- **Confidence estimation** based on depth range (far = low confidence)

This is a simplified model — it does not simulate actual image matching,
repetitive pattern errors, or lighting effects. For validation against
realistic stereo failure modes, use the Babylon adapter with real rendered
images and an actual stereo matcher (SGM or the future CNN matcher).

## Integration with the Navigation Pipeline

The navigation pipeline is a **configurable compute graph**. Stereo matching
is one of several depth source options, selectable at runtime:

```
Config A: LiDAR only
  [LidarSource] ──► [Convolution] ──► [PerceptCortex] ──► [DecisionCortex]

Config B: Stereo + classical matching (BM/SGM)
  [StereoCapture] ──► [BM/SGM] ──► [Convolution] ──► [Percept] ──► [Decision]

Config C: Stereo + CNN matching (planned)
  [StereoCapture] ──► [MatchingCNN] ──► [Convolution] ──► [Percept] ──► [Decision]

Config D: Fused
  [StereoCapture] ──► [BM/SGM] ──┐
                                  ├──► [Fusion] ──► [Convolution] ──► [Percept] ──► [Decision]
  [LidarSource] ────────────────┘
```

The `DepthFusionNode` selects the best source based on operating conditions:

- **Day + good texture** → stereo (passive, low power)
- **Night / textureless / stereo unhealthy** → LiDAR (active, reliable)

The PerceptCortex receives sectors regardless of source — it does not know
or care whether the depth came from stereo, LiDAR, or a CNN matcher. The
`IFusedDepthResult` carries the source type and confidence for logging
and MCP layer reasoning.
