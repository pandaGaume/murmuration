# Navigation Architecture

## Overview

The navigation system follows a **two-tier brain architecture** that separates
fast reactive control from slow strategic reasoning. This design mirrors
biological nervous systems: a spinal reflex arc (MLP cascade) handles
millisecond motor responses, while a cortex (MCP/LLM) handles planning
and adaptation.

![Architecture Overview](./images/architecture-overview.svg)

---

## Tier 1 — Perception & Reactive Control

### Sensor Layer

Four sensor types feed the navigation pipeline, all running at high
frequency (100+ Hz) within the simulation tick loop:

| Sensor             | Interface                   | Output                                      | Rate        | Role                                        |
| ------------------ | --------------------------- | ------------------------------------------- | ----------- | ------------------------------------------- |
| **IMU**            | `IIMU6Node`                 | `ICartesian3` (acc + gyro)                  | 100–1000 Hz | Short-term ego-motion, tilt, fall detection |
| **LiDAR**          | `ILidarNode`                | `ILidarScanResult` (depth grid)             | 10–30 Hz    | Obstacle detection, free-space mapping      |
| **Wheel Encoders** | `IWheelEncoderNode`         | `IWheelEncoderData` (ticks, velocity, slip) | 100+ Hz     | Ground-truth speed, traction monitoring     |
| **Odometry**       | `IDifferentialOdometryNode` | `IOdometryEstimate` (x, y, theta)           | 100+ Hz     | Dead-reckoning pose estimate                |

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

---

### Cascaded MLP — The Local Brain

The `NavigatorBrain` uses a **two-stage cascaded MLP** instead of a
single monolithic network. Each stage has a distinct responsibility:

![MLP Cascade Detail](./images/mlp-cascade-detail.svg)

**Total trainable parameters**: 824 + 420 = **1,244**

#### Stage 1 — MLP-Percept (Perception)

| Property   | Value                       | Rationale                                                                            |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------ |
| Input      | 42 neurons, linear          | LiDAR (36) + IMU (6), pass-through                                                   |
| Hidden     | 16 neurons, tanh            | Symmetric [−1,+1], learns obstacle features                                          |
| Output     | 8 neurons, tanh             | Learned features in [−1,+1] (not sigmoid — intermediate values need symmetric range) |
| Parameters | 42×16 + 16×8 + 16 + 8 = 824 |                                                                                      |

MLP-Percept answers the question "what's around me?" by compressing 42 raw
spatial inputs into 8 meaningful features. These features are **not
hand-designed** — the network learns to encode them during training or
evolution. Conceptually, they converge toward signals like:

- Front obstacle distance (near/far)
- Front obstacle bearing (left/right of center)
- Side clearance (left / right)
- Closing rate (from IMU acceleration + depth changes)
- Open corridor direction (where is the most free space)
- Terrain roughness (from IMU vibration pattern)

#### Stage 2 — MLP-Decide (Decision)

| Property   | Value                       | Rationale                                     |
| ---------- | --------------------------- | --------------------------------------------- |
| Input      | 21 neurons, linear          | Features (8) + pose (6) + slip (4) + goal (3) |
| Hidden     | 16 neurons, tanh            | Symmetric, learns control policy              |
| Output     | 4 neurons, sigmoid          | Bounded [0,1] for motor commands              |
| Parameters | 21×16 + 16×4 + 16 + 4 = 420 |                                               |

MLP-Decide answers "what do I do?" by mapping the clean perception features
plus ego-state and goal to motor commands. It receives a much cleaner signal
than raw depth data — 8 learned features instead of 36 noisy depth sectors.

**Output mapping:**

| Index | Signal   | Sigmoid range  | Physical mapping                   |
| ----- | -------- | -------------- | ---------------------------------- |
| 0     | Steering | 0.5 = straight | [−π/6, +π/6] radians (±30°)        |
| 1     | Throttle | 0 = stopped    | [0, 1] forward force ratio         |
| 2     | Brake    | 0 = coasting   | [0, 1] braking force ratio         |
| 3     | Risk     | 0 = safe       | When ≥ threshold → escalate to MCP |

#### Why Cascaded Instead of Monolithic?

The original design used a single 55→32→4 MLP (1,924 params) that handled
both perception and decision in one network. The cascaded design improves
on this in four ways:

1. **Learned features > raw depth**: MLP-Percept compresses 36 depth sectors
   into 8 meaningful signals. The decision network gets a much cleaner input.

2. **Each MLP stays small and trainable**: 824 + 420 = 1,244 total params
   (vs 1,924). Fewer parameters per network means faster convergence during
   training/evolution and less overfitting.

3. **Independent training/evolution**: Perception can be trained on "label
   the obstacles" tasks, then frozen while the decision MLP evolves on
   "reach the goal" tasks. Or swap perception models for different sensor
   configs (e.g., 16-beam vs 64-beam LiDAR) without retraining the
   control policy.

4. **Interpretable intermediate layer**: The 8 percept outputs are loggable,
   visualizable features. "Why did it turn left?" → inspect the percept
   output vector, not 36 raw depth sectors.

#### Design Choices

- **Why tanh on MLP-Percept output?** These are intermediate values fed
  into MLP-Decide, not final motor commands. Symmetric [−1,+1] range
  preserves directional information ("obstacle left" = negative,
  "obstacle right" = positive). Sigmoid would squash this into [0,1],
  losing the sign-based directional encoding.

- **Why sigmoid on MLP-Decide output?** Motor commands are inherently
  bounded and positive. Steering maps from [0,1] to [−30°,+30°] with 0.5
  as center. Throttle and brake are force ratios in [0,1]. Risk is a
  probability-like score.

- **Why not deeper?** Each MLP uses a single hidden layer. For the reactive
  mappings needed (weighted sums of distances, angles, and features), one
  hidden layer provides enough capacity. More layers would add latency and
  make evolutionary mutation less effective — changes in early layers get
  diluted through multiple non-linearities.

- **Why Glorot initialization?** Scales initial weights by
  `sqrt(2 / (fan_in + fan_out))`, keeping activations from saturating
  at generation 0. This gives mutation a reasonable starting distribution.

---

## Tier 2 — Strategic Layer (MCP / LLM)

The MCP layer operates at a much lower cadence (1–5 Hz). It does **not**
drive motors directly — it sets intent that Tier 1 executes reactively.

### Responsibilities

| Capability                  | Mechanism                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Set navigation goals**    | `setGoal(INavigatorGoal)` — push a waypoint into the decision MLP input tensor                                                             |
| **Swap perception weights** | `loadPerceptWeights(uri)` — switch obstacle detection models for different environments (indoor vs outdoor, dense vs sparse)               |
| **Swap decision weights**   | `loadDecisionWeights(uri)` — switch control policies (road vs off-road, calm vs aggressive)                                                |
| **Handle escalations**      | Monitor the MLP-Decide `risk` output; when `escalate = true`, reason about alternatives                                                    |
| **Inspect perception**      | Read `lastPerceptFeatures` to understand what the perception MLP "sees" — enables LLM-level reasoning about the spatial situation          |
| **Contextual reasoning**    | Use LLM capabilities for scenarios that a 1,244-parameter cascade cannot handle (construction zones, traffic signals, ambiguous obstacles) |

### Weight Loading

The `IWeightLoader` interface decouples weight storage from both brains:

```typescript
interface IWeightLoader {
    load(uri: string): Promise<{ weights: number[]; biases: number[] }>;
}
```

Implementations can load from any transport (file system, HTTP, IndexedDB)
and any format (JSON, binary, protobuf). The weight loader is shared by
both MLPs but each maintains independent weight sets.

When weights are loaded into either sub-brain:

1. Synapse weights and neuron biases are applied to the `IMlpGraph`.
2. The `MLPInferenceRuntime` is recompiled to reflect the new parameters.
3. The next `onTick()` uses the updated brain immediately — no downtime.

### Escalation Flow

```
MLP-Decide output: risk = 0.92 (≥ threshold 0.8)
    │
    ▼
INavigationCommand.escalate = true
    │
    ▼
MCP layer receives notification (via sensor event at 1–5 Hz)
    │
    ├── Read lastPerceptFeatures: [0.9, -0.3, 0.1, ...] → "large obstacle front-right"
    ├── Reason about alternatives
    └── Decision:
        ├── setGoal(newWaypoint)              → reroute around obstacle
        ├── loadPerceptWeights("indoor-v2")   → switch to indoor obstacle model
        ├── loadDecisionWeights("off-road")   → switch to terrain-adapted policy
        └── emergencyStop()                   → halt and request human input
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
│       ├── sensors.differential-odometry.ts     DifferentialOdometry (N-wheel impl)
│       └── index.ts
│
├── navigation/                 Cascaded MLP brain & command output
│   ├── navigation.interfaces.ts  IPerceptBrain, IDecisionBrain,
│   │                             INavigatorBrain, INavigatorInputTensor,
│   │                             INavigationCommand, IWeightLoader,
│   │                             INavigatorBrainOptions, INavigatorNode
│   ├── navigation.brain.ts       PerceptBrain (42→16→8),
│   │                             DecisionBrain (21→16→4),
│   │                             NavigatorBrain (cascaded)
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
    ├── IMlpGraph, MLPInferenceRuntime ──► IPerceptBrain, IDecisionBrain
    │                                     │
    └── PerceptronBuilder, Glorot... ──► PerceptBrain, DecisionBrain (impls)

@dev/core/telemetry
    │
    └── IRecord ────────────────────► ISensorEventEmitter<TEvent>
                                      │
                                      ├── IAccelerometerEvent
                                      ├── IGyroEvent
                                      ├── ILidarEvent
                                      ├── IWheelEncoderEvent
                                      ├── IOdometryEvent
                                      └── INavigationCommandEvent

@dev/core/perception
    │
    ├── ISensorNode ────────────────► IIMU6Node
    ├── ISensorNode ────────────────► ILidarNode
    ├── ISensorNode ────────────────► IWheelEncoderNode
    ├── ISensorNode ────────────────► IDifferentialOdometryNode
    └── ISensorNode ────────────────► INavigatorNode

@dev/core/navigation
    │
    ├── IPerceptBrain ◄──────────── PerceptBrain (42→16→8)
    ├── IDecisionBrain ◄─────────── DecisionBrain (21→16→4)
    ├── INavigatorBrain ◄────────── NavigatorBrain (cascade)
    ├── IWeightLoader ◄──────────── (user-provided impl)
    └── INavigatorNode ─── consumes ──► IMU + LiDAR + Wheels + Odometry
                       └── produces ──► INavigationCommand
```

---

## Data Flow Summary

1. **Sensors** produce raw readings every tick (`onTick(dtMs)`).
2. **State fusion** normalizes and combines them into structured tensors.
3. **MLP-Percept** compresses LiDAR (36) + IMU (6) → 8 learned features (~0.05ms).
4. **MLP-Decide** maps features (8) + pose (6) + slip (4) + goal (3) → 4 motor outputs (~0.05ms).
5. **`INavigationCommand`** is emitted as a sensor event for actuators.
6. **MCP layer** (1–5 Hz) monitors risk, inspects percept features, sets goals, swaps weights.

The critical invariant: **Tier 1 never waits for Tier 2.** The MLP cascade
always produces a valid command from the latest sensor state. The MCP layer
influences behavior asynchronously by:

- Adjusting the goal vector (takes effect next tick)
- Swapping percept weights (changes what features the network "sees")
- Swapping decision weights (changes the control policy)

None of these operations block the control loop.

---

## Parameter Budget Comparison

| Architecture                       | Weights | Biases | Total | Inference |
| ---------------------------------- | ------- | ------ | ----- | --------- |
| **Monolithic** 55→32→4             | 1,888   | 36     | 1,924 | ~0.1ms    |
| **Cascaded** [42→16→8] + [21→16→4] | 1,200   | 44     | 1,244 | ~0.1ms    |

The cascaded design uses **35% fewer parameters** while providing better
separation of concerns, independent trainability, and interpretable
intermediate features.
