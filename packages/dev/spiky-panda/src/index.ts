// ═══════════════════════════════════════════════════════════════════════════
// spiky-panda-ext — local sandbox for @spiky-panda/core extensions
//
// Contains generic compute infrastructure that will eventually be
// merged into @spiky-panda/core. Developed here first to iterate
// without modifying the upstream package.
//
// Modules:
//   compute/  — ONNX-like compute graph (ITensor, IComputeNode, ComputeGraph)
//   (future)  — CNN layers, pooling, etc.
// ═══════════════════════════════════════════════════════════════════════════

export * from "./compute/index";
