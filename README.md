# Murmuration

Autonomous navigation framework for simulated agents (rovers, drones, swarms) using cascaded MLPs trained via evolutionary and supervised methods, orchestrated by an LLM strategic layer through MCP.

## What this is

A TypeScript monorepo that provides:

- **Perception** — sensor abstractions (IMU, LiDAR, wheel encoders, odometry) with a pluggable depth pipeline (CPU math or GPU depth buffer)
- **Navigation** — a two-stage MLP cascade (PerceptCortex + DecisionCortex) for reactive obstacle avoidance and goal-seeking
- **Training** — scenario generation, ground truth labeling, supervised backprop and evolutionary training loops, all framework-agnostic
- **3D adapters** — Babylon.js implementations of all sensors, designed to extend to Three.js or Cesium

The MLP brain runs at sensor rate (~100 Hz, sub-millisecond inference). An MCP/LLM layer operates at 1–5 Hz for strategic decisions: setting goals, swapping weights, handling edge cases the MLP can't resolve.

See [docs/navigation-architecture.md](docs/navigation-architecture.md) for the full architecture, and [docs/differential-odometry.md](docs/differential-odometry.md) for the N-wheel odometry algorithm.

## Getting started

```bash
git clone <repo-url>
cd murmuration
npm install
npm run build:all    # clean + compile all packages
npm run bundle:all   # build + webpack bundles
```

## Package structure

```
packages/dev/
  core/       Framework-agnostic interfaces, MLP brain, odometry, math/units
  babylon/    Babylon.js sensor adapters (IMU, LiDAR, wheels)
  training/   Scenarios, labeling, dataset management, training loops
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build:all` | Clean and compile all packages |
| `npm run bundle:all` | Build + produce UMD bundles |
| `npm run lint:check` | ESLint across all packages |
| `npm run format:check` | Prettier check |

## Requirements

- Node.js >= 20.11.0
- npm >= 8.0.0
