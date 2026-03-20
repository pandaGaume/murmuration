# Murmuration

Autonomous navigation framework for simulated agents (rovers, drones, swarms) using cascaded MLPs trained via evolutionary and supervised methods, orchestrated by an LLM strategic layer through MCP.

## What this is

A TypeScript monorepo that provides:

- **Perception** — sensor abstractions (IMU, stereo vision, LiDAR, wheel encoders, odometry) with a pluggable depth pipeline (CPU math or GPU depth buffer) and stereo/LiDAR fusion
- **Navigation** — a configurable compute graph pipeline with cascaded MLPs (PerceptCortex + DecisionCortex) for reactive obstacle avoidance and goal-seeking
- **Training** — scenario generation, ground truth labeling, supervised backprop and evolutionary training loops, all framework-agnostic
- **Compute graph** — ONNX-like configurable DAG for swapping depth sources and matching strategies at runtime
- **3D adapters** — Babylon.js implementations of all sensors, designed to extend to Three.js or Cesium

The MLP brain runs at sensor rate (~100 Hz, sub-millisecond inference). An MCP/LLM layer operates at 1–5 Hz for strategic decisions: setting goals, swapping weights, handling edge cases the MLP can't resolve.

See [docs/navigation-architecture.md](docs/navigation-architecture.md) for the full architecture, [docs/stereo-vision.md](docs/stereo-vision.md) for stereo matching algorithms and trade-offs, and [docs/differential-odometry.md](docs/differential-odometry.md) for the N-wheel odometry algorithm.

## Getting started

```bash
git clone <repo-url>
cd murmuration
npm install
npm run build:all    # clean + compile all packages
npm run dist         # build + bundle + deploy to host
npm run serve        # start local server on port 8080
```

## Package structure

```
packages/
  dev/
    spiky-panda/   Compute graph infrastructure (ITensor, IComputeNode, ComputeGraph)
                   Local sandbox for @spiky-panda/core extensions (future: CNN)
    core/          Framework-agnostic interfaces, MLP brain, odometry, math/units,
                   navigation compute nodes, PipelineBuilder (CNN matcher planned)
    babylon/       Babylon.js sensor adapters (IMU, LiDAR, stereo, wheels)
    training/      Scenarios, labeling, dataset management, training loops
  host/
    www/           Static host — serves the bundled libraries
      lib/         UMD bundles deployed by `npm run dist`
      index.html   Entry point
```

## Scripts

| Command                | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `npm run build:all`    | Clean and compile all packages (`tsc -b`)            |
| `npm run bundle:all`   | Build + produce UMD bundles (webpack)                |
| `npm run dist`         | Build + bundle + deploy bundles to `host/www/lib/`   |
| `npm run deploy-bundles` | Copy bundles to `host/www/lib/` (without rebuilding) |
| `npm run serve`        | Start http-server on port 8080 serving `host/www/`   |
| `npm run lint:check`   | ESLint across all packages                           |
| `npm run format:check` | Prettier check                                       |

## Build pipeline

```
npm run dist
  │
  ├── 1. clean          → rimraf all dist/ and bundle/ folders
  ├── 2. tsc -b         → compile TS in dependency order:
  │      spiky-panda → core → babylon → training
  ├── 3. webpack         → produce UMD bundles:
  │      spiky-panda-ext.js
  │      murmuration-core.js
  │      murmuration-babylon.js
  │      murmuration-training.js
  └── 4. deploy-bundles  → copy .js + .js.map to host/www/lib/
```

## Requirements

- Node.js >= 20.11.0
- npm >= 8.0.0
