# Navigation Architecture

## Overview

The navigation system follows a **two-tier brain architecture** that separates
fast reactive control from slow strategic reasoning. This design mirrors
biological nervous systems: a spinal reflex arc (MLP) handles millisecond
motor responses, while a cortex (MCP/LLM) handles planning and adaptation.

```
Sensors (100+ Hz)
    │
    ├── IMU ──────┐
    ├── LiDAR ────┤
    ├── Wheels ───┤
    ├── Odometry ─┤
    │             ▼
    │     ┌──────────────┐
    │     │ State Fusion  │ ← EKF / complementary filter
    │     └──────┬───────┘
    │            ▼
    │   ┌────────────────┐
    │   │  MLP (local    │ ← fixed-size input tensor
    │   │  brain)        │   deterministic, ~0.1ms
    │   └───────┬────────┘
    │           ▼
    │   INavigationCommand (steer, throttle, brake)
    │
    ▼ (downsampled, ~1-5 Hz)
┌────────────────────┐
│  MCP / LLM         │ ← strategic layer
│  (remote brain)    │   sets goals, adjusts MLP,
└────────────────────┘   handles edge cases
```

---

## Tier 1 — Perception & Reactive Control

### Sensor Layer

Four sensor types feed the navigation pipeline, all running at high
frequency (100+ Hz) within the simulation tick loop:

| Sensor | Interface | Output | Rate | Role |
|--------|-----------|--------|------|------|
| **IMU** | `IIMU6Node` | `ICartesian3` (acc + gyro) | 100–1000 Hz | Short-term ego-motion, tilt, fall detection |
| **LiDAR** | `ILidarNode` | `ILidarScanResult` (depth grid) | 10–30 Hz | Obstacle detection, free-space mapping |
| **Wheel Encoders** | `IWheelEncoderNode` | `IWheelEncoderData` (ticks, velocity, slip) | 100+ Hz | Ground-truth speed, traction monitoring |
| **Odometry** | `IDifferentialOdometryNode` | `IOdometryEstimate` (x, y, theta) | 100+ Hz | Dead-reckoning pose estimate |

Every sensor implements `ISensorNode` — it participates in the `ISimSpace`
graph and receives `onTick(dtMs)` calls each frame. Sensors expose two
consumption patterns:

- **Pull**: `sensorRead()` returns the latest value synchronously (used by
  the state fusion step inside the tick loop).
- **Push**: `onSensorEvent(callback)` emits batched records asynchronously
  (used by telemetry loggers and the MCP layer).

### State Fusion

Raw sensor readings drift and disagree. The state fusion step combines
them into a single, confidence-weighted estimate:

- **IMU** provides high-frequency but drift-prone angular/linear rates.
- **Odometry** provides medium-frequency ground-truth but accumulates
  integration error over time.
- **LiDAR** can correct drift via scan matching (comparing successive
  depth frames against the estimated pose).
- **Wheel slip** flags from the encoders signal when odometry should be
  down-weighted (the `reliable` flag on `IOdometryEstimate` feeds into
  the confidence weighting).

The fused output is a normalized input tensor (`INavigatorInputTensor`)
ready for the MLP:

```
Index   Field                Count   Range
──────  ───────────────────  ──────  ──────────
0–5     Pose & velocity      6      [−1, 1]
6–11    IMU snapshot          6      [−1, 1]
12–47   LiDAR sectors        36      [0, 1]
48–51   Wheel slip ratios     4      [0, 1]
52–54   Goal vector           3      [−1, 1]
                             ──
                        Total: 55 floats
```

### MLP — The Local Brain

The `NavigatorBrain` is a compact multi-layer perceptron that runs
inference at sensor rate with deterministic, sub-millisecond latency.

**Architecture: 55 → 32 → 4**

```
Input (55 neurons, linear)
  │
  │  55 × 32 = 1,760 weights
  ▼
Hidden (32 neurons, tanh)
  │
  │  32 × 4 = 128 weights
  ▼
Output (4 neurons, sigmoid)
```

**Total trainable parameters**: 1,760 + 128 weights + 32 + 4 biases = **1,924**

| Layer | Activation | Rationale |
|-------|-----------|-----------|
| Input (55) | Linear | Pass-through — no information loss on pre-normalized values |
| Hidden (32) | Tanh | Symmetric [−1, +1] matches sensor data distribution; bounded output prevents activation explosion under weight mutation |
| Output (4) | Sigmoid | Bounded [0, 1] maps naturally to motor controls; no clamping needed |

**Output mapping:**

| Index | Signal | Sigmoid range | Physical mapping |
|-------|--------|--------------|-----------------|
| 0 | Steering | 0.5 = straight | [−π/6, +π/6] radians (±30°) |
| 1 | Throttle | 0 = stopped | [0, 1] forward force ratio |
| 2 | Brake | 0 = coasting | [0, 1] braking force ratio |
| 3 | Risk | 0 = safe | When ≥ threshold → escalate to MCP |

**Design choices:**

- **Why not deeper?** A single hidden layer is sufficient for the reactive
  mappings needed (weighted sums of distances and angles). More layers
  add latency and make mutation less effective — changes in early layers
  get diluted through multiple non-linearities.
- **Why Glorot initialization?** Scales initial weights by
  `sqrt(2 / (fan_in + fan_out))`, keeping activations from saturating
  at generation 0. This gives mutation a reasonable starting distribution.
- **Why 32 hidden neurons?** Sweet spot between capacity and speed.
  Enough to learn obstacle avoidance + goal tracking, small enough for
  sub-millisecond inference at 100+ Hz across multiple agents.

---

## Tier 2 — Strategic Layer (MCP / LLM)

The MCP layer operates at a much lower cadence (1–5 Hz). It does **not**
drive motors directly — it sets intent that Tier 1 executes reactively.

### Responsibilities

| Capability | Mechanism |
|-----------|-----------|
| **Set navigation goals** | `setGoal(INavigatorGoal)` — push a waypoint into the MLP input tensor |
| **Swap MLP weights** | `loadWeights(uri)` via `IWeightLoader` — switch behavior profiles (road vs off-road, calm vs aggressive) |
| **Handle escalations** | Monitor the MLP's `risk` output; when `escalate = true`, reason about alternatives (reroute, stop, request human input) |
| **Contextual reasoning** | Use LLM capabilities to interpret complex scenarios that a 1,924-parameter MLP cannot handle (e.g., construction zones, traffic signals, ambiguous obstacles) |

### Weight Loading

The `IWeightLoader` interface decouples weight storage from the brain:

```typescript
interface IWeightLoader {
    load(uri: string): Promise<{ weights: number[]; biases: number[] }>;
}
```

Implementations can load from any transport (file system, HTTP, IndexedDB)
and any format (JSON, binary, protobuf). When weights are loaded:

1. Synapse weights and neuron biases are applied to the `IMlpGraph`.
2. The `MLPInferenceRuntime` is recompiled to reflect the new parameters.
3. The next `onTick()` uses the updated brain immediately — no downtime.

### Escalation Flow

```
MLP output: risk = 0.92 (≥ threshold 0.8)
    │
    ▼
INavigationCommand.escalate = true
    │
    ▼
MCP layer receives notification (via sensor event at 1–5 Hz)
    │
    ├── Query obstacle map: "what is ahead?"
    ├── Reason about alternatives
    └── Decision:
        ├── setGoal(newWaypoint)     → reroute around obstacle
        ├── loadWeights("off-road")  → switch to terrain-adapted behavior
        └── emergencyStop()          → halt and request human input
```

---

## Module Structure

```
packages/dev/core/src/
│
├── telemetry/                  Data flow & quality model
│   ├── dataflow.interfaces.ts    IIndexed, ITimed, ISequenceable
│   ├── telemetry.interfaces.ts   IRecord, ITimeSerie, ISample, QualityLevel
│   └── index.ts
│
├── simulation/                 Tick loop & graph
│   ├── sim.interfaces.ts         ISimNode, ISimSpace
│   └── index.ts
│
├── perception/                 Sensor abstractions
│   └── sensors/
│       ├── sensors.interfaces.ts           ISensor, ISensorReadable, ISensorWritable,
│       │                                   ISensorEventEmitter, ISensorNode
│       ├── sensors.imu.interfaces.ts       IAccelerometerNode, IGyroNode, IIMU6Node
│       ├── sensors.lidar.interfaces.ts     ILidarScanOptions, ILidarScanResult, ILidarNode
│       ├── sensors.wheel-encoder.interfaces.ts  IWheelEncoderNode, IDifferentialOdometryNode
│       └── index.ts
│
├── navigation/                 MLP brain & command output
│   ├── navigation.interfaces.ts  INavigatorInputTensor, INavigatorBrain,
│   │                             INavigationCommand, IWeightLoader,
│   │                             INavigatorBrainOptions, INavigatorNode
│   ├── navigation.brain.ts       NavigatorBrain (55→32→4 MLP implementation)
│   └── index.ts
│
└── index.ts                    Re-exports all modules
```

---

## Interface Dependency Graph

```
@spiky-panda/core
    │
    ├── INode, IGraph, IOlink ──────► ISimNode, ISimSpace
    │                                     │
    ├── IIDentifiable, IDisposable ──► ISensor
    │                                     │
    ├── ICartesian3 ────────────────► IAccelerometerNode, IGyroNode
    │                                     │
    ├── IMlpGraph, MLPInferenceRuntime ──► INavigatorBrain
    │                                     │
    └── PerceptronBuilder, Glorot... ──► NavigatorBrain (impl)

core/telemetry
    │
    └── IRecord ────────────────────► ISensorEventEmitter<TEvent>
                                      │
                                      ├── IAccelerometerEvent
                                      ├── IGyroEvent
                                      ├── ILidarEvent
                                      ├── IWheelEncoderEvent
                                      ├── IOdometryEvent
                                      └── INavigationCommandEvent

core/perception
    │
    ├── ISensorNode ────────────────► IIMU6Node
    ├── ISensorNode ────────────────► ILidarNode
    ├── ISensorNode ────────────────► IWheelEncoderNode
    ├── ISensorNode ────────────────► IDifferentialOdometryNode
    └── ISensorNode ────────────────► INavigatorNode

core/navigation
    │
    ├── INavigatorBrain ◄──────────── NavigatorBrain
    ├── IWeightLoader ◄──────────── (user-provided impl)
    └── INavigatorNode ─── consumes ──► IMU + LiDAR + Wheels + Odometry
                       └── produces ──► INavigationCommand
```

---

## Data Flow Summary

1. **Sensors** produce raw readings every tick (`onTick(dtMs)`).
2. **State fusion** normalizes and combines them into a 55-float tensor.
3. **MLP** runs feed-forward inference in ~0.1ms → 4-float output.
4. **`INavigationCommand`** is emitted as a sensor event for actuators.
5. **MCP layer** (1–5 Hz) monitors risk, sets goals, swaps weights.

The critical invariant: **Tier 1 never waits for Tier 2.** The MLP always
produces a valid command from the latest sensor state. The MCP layer
influences behavior asynchronously by adjusting the goal vector or
swapping the weight set — both take effect on the next tick without
blocking the control loop.
