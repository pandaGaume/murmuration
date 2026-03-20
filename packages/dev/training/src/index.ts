// ═══════════════════════════════════════════════════════════════════════════
// murmuration-training — Training pipeline for the navigation MLP cascade
//
// This package is framework-agnostic. It depends only on:
// - murmuration-core (sensor/navigation interfaces)
// - @spiky-panda/core (MLP graph and runtime)
//
// 3D frameworks (Babylon, Three.js, Cesium) are NOT required.
// Scenarios are pure geometry. LiDAR is simulated via ray-math.
// IMU is simulated via motion state derivatives.
//
// Modules:
//   scenario/  — geometry primitives, raycaster, scenario generators
//   labels/    — ground truth computation for PerceptCortex outputs
//   dataset/   — storage, splitting, serialization
//   loops/     — supervised and evolutionary training loops
// ═══════════════════════════════════════════════════════════════════════════

export * from "./scenario";
export * from "./labels";
export * from "./dataset";
export * from "./loops";
