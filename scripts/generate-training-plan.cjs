const fs = require("fs");
const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    Header, Footer, AlignmentType, LevelFormat, HeadingLevel,
    BorderStyle, WidthType, ShadingType, PageNumber, PageBreak,
    TableOfContents
} = require("docx");

// ── Constants ──────────────────────────────────────────────
const PAGE_WIDTH = 12240;
const MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN; // 9360
const ACCENT = "2E75B6";
const LIGHT_ACCENT = "D5E8F0";
const LIGHT_GRAY = "F2F2F2";
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

// ── Helpers ────────────────────────────────────────────────
function heading(text, level) {
    return new Paragraph({
        heading: level,
        spacing: { before: level === HeadingLevel.HEADING_1 ? 360 : 240, after: 120 },
        children: [new TextRun({ text, bold: true, font: "Arial",
            size: level === HeadingLevel.HEADING_1 ? 32 : level === HeadingLevel.HEADING_2 ? 28 : 24 })]
    });
}

function para(text, opts = {}) {
    return new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text, font: "Arial", size: 22, ...opts })]
    });
}

function bullet(text, level = 0) {
    return new Paragraph({
        numbering: { reference: "bullets", level },
        spacing: { after: 60 },
        children: [new TextRun({ text, font: "Arial", size: 22 })]
    });
}

function boldBullet(label, desc, level = 0) {
    return new Paragraph({
        numbering: { reference: "bullets", level },
        spacing: { after: 60 },
        children: [
            new TextRun({ text: label + " ", font: "Arial", size: 22, bold: true }),
            new TextRun({ text: desc, font: "Arial", size: 22 })
        ]
    });
}

function codeBlock(text) {
    return new Paragraph({
        spacing: { before: 60, after: 120 },
        shading: { fill: LIGHT_GRAY, type: ShadingType.CLEAR },
        indent: { left: 360 },
        children: [new TextRun({ text, font: "Consolas", size: 18 })]
    });
}

function tableRow(cells, isHeader = false) {
    const colWidth = Math.floor(CONTENT_WIDTH / cells.length);
    return new TableRow({
        children: cells.map(text => new TableCell({
            borders,
            width: { size: colWidth, type: WidthType.DXA },
            margins: cellMargins,
            shading: isHeader ? { fill: ACCENT, type: ShadingType.CLEAR } : undefined,
            children: [new Paragraph({
                children: [new TextRun({
                    text, font: "Arial", size: 20,
                    bold: isHeader, color: isHeader ? "FFFFFF" : "000000"
                })]
            })]
        }))
    });
}

function simpleTable(headers, rows) {
    const colWidth = Math.floor(CONTENT_WIDTH / headers.length);
    return new Table({
        width: { size: CONTENT_WIDTH, type: WidthType.DXA },
        columnWidths: headers.map(() => colWidth),
        rows: [
            tableRow(headers, true),
            ...rows.map(r => tableRow(r))
        ]
    });
}

// ── Document ───────────────────────────────────────────────
const doc = new Document({
    styles: {
        default: { document: { run: { font: "Arial", size: 22 } } },
        paragraphStyles: [
            { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
                run: { size: 32, bold: true, font: "Arial", color: ACCENT },
                paragraph: { spacing: { before: 360, after: 240 }, outlineLevel: 0 } },
            { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
                run: { size: 28, bold: true, font: "Arial", color: ACCENT },
                paragraph: { spacing: { before: 240, after: 180 }, outlineLevel: 1 } },
            { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
                run: { size: 24, bold: true, font: "Arial" },
                paragraph: { spacing: { before: 180, after: 120 }, outlineLevel: 2 } },
        ]
    },
    numbering: {
        config: [
            { reference: "bullets",
                levels: [
                    { level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
                        style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
                    { level: 1, format: LevelFormat.BULLET, text: "\u25E6", alignment: AlignmentType.LEFT,
                        style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
                ] },
            { reference: "phases",
                levels: [
                    { level: 0, format: LevelFormat.DECIMAL, text: "Phase %1.", alignment: AlignmentType.LEFT,
                        style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
                ] },
        ]
    },
    sections: [
        // ── COVER PAGE ──
        {
            properties: {
                page: {
                    size: { width: PAGE_WIDTH, height: 15840 },
                    margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }
                }
            },
            children: [
                new Paragraph({ spacing: { before: 4000 } }),
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({ text: "MURMURATION", font: "Arial", size: 56, bold: true, color: ACCENT })]
                }),
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 200, after: 400 },
                    children: [new TextRun({ text: "LLM-Driven Training Architecture", font: "Arial", size: 36, color: "555555" })]
                }),
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 200 },
                    border: { top: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 12 } },
                    children: [new TextRun({ text: "Planning Document", font: "Arial", size: 28, color: "888888" })]
                }),
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 200 },
                    children: [new TextRun({ text: "March 2026 \u2014 Internal Draft", font: "Arial", size: 22, color: "AAAAAA" })]
                }),
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 600 },
                    children: [new TextRun({ text: "Autonomous Navigation via MCP-Orchestrated Neural Training", font: "Arial", size: 22, italics: true, color: "888888" })]
                }),
            ]
        },
        // ── TOC ──
        {
            properties: {
                page: {
                    size: { width: PAGE_WIDTH, height: 15840 },
                    margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }
                }
            },
            headers: {
                default: new Header({ children: [new Paragraph({
                    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT, space: 4 } },
                    children: [new TextRun({ text: "Murmuration \u2014 LLM-Driven Training Plan", font: "Arial", size: 18, color: "888888" })]
                })] })
            },
            footers: {
                default: new Footer({ children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({ text: "Page ", font: "Arial", size: 18 }), new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 18 })]
                })] })
            },
            children: [
                heading("Table of Contents", HeadingLevel.HEADING_1),
                new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),
                new Paragraph({ children: [new PageBreak()] }),

                // ── 1. VISION ──
                heading("1. Vision & Motivation", HeadingLevel.HEADING_1),
                para("The Murmuration project aims to build an autonomous navigation system for planetary rovers. " +
                    "The core idea: use a local MLP cascade (PerceptCortex + DecisionCortex) for real-time " +
                    "reactive navigation, while a remote LLM via MCP acts as a strategic supervisor \u2014 " +
                    "generating training scenarios, evaluating brain performance, and orchestrating curriculum learning."),
                para("This document describes the planned architecture for LLM-driven training: " +
                    "how an LLM (via a dedicated MCP server and Claude Code skill) will dynamically create " +
                    "simulation scenarios, run training loops, and iteratively improve the navigation brain."),

                // ── 2. ARCHITECTURE OVERVIEW ──
                heading("2. Architecture Overview", HeadingLevel.HEADING_1),
                heading("2.1 Two-Tier Brain Architecture", HeadingLevel.HEADING_2),
                para("The navigation system operates on two tiers with fundamentally different latency budgets:"),
                simpleTable(
                    ["Tier", "Component", "Latency", "Role"],
                    [
                        ["Tier 1 (local)", "MLP Cascade", "< 0.1 ms", "Reactive navigation: obstacle avoidance, steering, throttle"],
                        ["Tier 1 (local)", "Sensor Fusion (EKF)", "< 1 ms", "Fused state estimation from IMU + odometry + depth"],
                        ["Tier 2 (remote)", "LLM via MCP", "1\u20135 Hz", "Strategic decisions: goal setting, weight updates, rerouting"],
                        ["Tier 2 (remote)", "Training Supervisor", "Offline", "Scenario generation, curriculum learning, evaluation"],
                    ]
                ),

                heading("2.2 MLP Cascade (Tier 1)", HeadingLevel.HEADING_2),
                para("The local brain consists of two cascaded MLPs:"),
                boldBullet("PerceptCortex (42 \u2192 16 \u2192 8):", "Transforms raw sensor data (36 LiDAR depth sectors + 6 IMU values) into 8 semantic features: obstacle proximity, bearing, clearance, closing rate, corridor direction, terrain roughness, confidence."),
                boldBullet("DecisionCortex (21 \u2192 16 \u2192 4):", "Consumes 8 percept features + 6 pose/velocity + 4 wheel slip + 3 goal vector to output steering, throttle, brake, and risk score."),
                para("Total parameters: ~1,168 (768 percept + 400 decision). Sub-millisecond inference at 100+ Hz."),

                heading("2.3 Configurable Compute Pipeline", HeadingLevel.HEADING_2),
                para("The depth-to-decision pipeline is a configurable compute graph (ONNX-like DAG). " +
                    "Nodes are compute stages, edges define data flow. Configurations can be swapped at runtime:"),
                simpleTable(
                    ["Config", "Pipeline", "Use Case"],
                    [
                        ["A", "LiDAR \u2192 Convolution \u2192 Percept \u2192 Decision", "Night / precision survey"],
                        ["B", "Stereo \u2192 BM/SGM \u2192 Convolution \u2192 Percept \u2192 Decision", "Day / low power"],
                        ["C", "Stereo \u2192 CNN Matcher \u2192 Convolution \u2192 Percept \u2192 Decision", "Day / difficult terrain (planned)"],
                        ["D", "Stereo + LiDAR \u2192 Fusion \u2192 Convolution \u2192 Percept \u2192 Decision", "Maximum reliability"],
                    ]
                ),

                new Paragraph({ children: [new PageBreak()] }),

                // ── 3. MCP SERVER FOR TRAINING ──
                heading("3. MCP Server: Training Orchestration", HeadingLevel.HEADING_1),
                heading("3.1 Server Architecture", HeadingLevel.HEADING_2),
                para("A dedicated MCP server (McpTrainingBehavior) exposes the training pipeline as tools. " +
                    "This follows the same adapter pattern used in mcp-for-babylon for camera and scene tools."),
                codeBlock("packages/dev/training/src/mcp/  \u2190 MCP server + behaviors"),
                codeBlock("  mcp.training.behavior.ts      \u2190 tool definitions"),
                codeBlock("  mcp.training.server.ts         \u2190 server bootstrap"),

                heading("3.2 Exposed MCP Tools", HeadingLevel.HEADING_2),
                simpleTable(
                    ["Tool", "Input", "Output", "Description"],
                    [
                        ["scenario_create", "dimensions, unit, name", "scenario_id", "Create empty scenario with world bounds"],
                        ["obstacle_add", "scenario_id, type, position, size, material", "obstacle_id", "Add obstacle geometry (box, cylinder, heightmap)"],
                        ["terrain_generate", "scenario_id, algorithm, params", "terrain_id", "Procedural terrain (Perlin noise, craters, slopes)"],
                        ["rover_configure", "scenario_id, sensors, pipeline_config", "rover_id", "Place rover with sensor suite and pipeline selection"],
                        ["rover_set_goal", "rover_id, target_pose", "ack", "Set navigation target waypoint"],
                        ["pipeline_set", "rover_id, config (A/B/C/D)", "ack", "Switch depth pipeline at runtime"],
                        ["training_run", "config (epochs, lr, mode)", "training_id", "Launch supervised or evolutionary training"],
                        ["training_status", "training_id", "loss, accuracy, epoch", "Poll training progress"],
                        ["brain_evaluate", "brain_id, test_scenarios[]", "metrics", "Evaluate brain on test set"],
                        ["brain_export", "brain_id, path", "file_path", "Export weights for deployment"],
                        ["weights_load", "brain_id, uri", "ack", "Load pre-trained weights"],
                        ["weights_swap", "brain_id, cortex, uri", "ack", "Hot-swap a single cortex's weights"],
                    ]
                ),

                heading("3.3 Dynamic Scenario Generation via LLM", HeadingLevel.HEADING_2),
                para("The key innovation: the LLM does not just call tools in sequence \u2014 it reasons about " +
                    "what scenarios to create based on the brain's current weaknesses."),
                para("Example conversation flow:", { bold: true }),
                codeBlock("LLM: \"brain_evaluate on 50 random scenarios\""),
                codeBlock("MCP: { success_rate: 0.72, failure_modes: [\"textureless_wall\": 8, \"narrow_passage\": 5] }"),
                codeBlock("LLM: \"The brain fails on textureless walls. Generate 200 scenarios with large flat surfaces.\""),
                codeBlock("MCP: scenario_create \u2192 obstacle_add(type: wall, size: large) \u00d7 200"),
                codeBlock("LLM: \"training_run supervised on these 200 scenarios, 50 epochs\""),
                codeBlock("MCP: { final_loss: 0.012, percept_accuracy: 0.94 }"),
                codeBlock("LLM: \"Re-evaluate on the full test set\""),
                codeBlock("MCP: { success_rate: 0.85 } \u2190 improvement confirmed"),

                new Paragraph({ children: [new PageBreak()] }),

                // ── 4. CURRICULUM LEARNING ──
                heading("4. Curriculum Learning Strategy", HeadingLevel.HEADING_1),
                heading("4.1 Phase-Based Training", HeadingLevel.HEADING_2),
                para("The LLM orchestrates training in progressive phases:"),

                boldBullet("Phase 1 \u2014 Supervised Perception:", "Train PerceptCortex alone on labeled sensor data. Ground truth computed algorithmically from scenario geometry. Goal: the cortex can accurately extract obstacle features from raw depth."),
                boldBullet("Phase 2 \u2014 Basic Navigation:", "Simple scenarios (flat terrain, single obstacle). Evolutionary training of the full cascade. Fitness: reach goal without collision."),
                boldBullet("Phase 3 \u2014 Complex Environments:", "Multiple obstacles, narrow passages, dead ends. The LLM analyzes failure modes and generates targeted scenarios."),
                boldBullet("Phase 4 \u2014 Adversarial Terrain:", "Slopes, low-friction surfaces, textureless walls, dynamic obstacles. Stereo failure modes injected. LiDAR/stereo fusion tested."),
                boldBullet("Phase 5 \u2014 Endurance & Generalization:", "Long-distance navigation with varied terrain. Test odometry drift, sensor degradation, wheel slip recovery."),

                heading("4.2 Automatic Difficulty Scaling", HeadingLevel.HEADING_2),
                para("The LLM monitors success rate and adjusts difficulty:"),
                simpleTable(
                    ["Success Rate", "LLM Action"],
                    [
                        ["> 90%", "Increase difficulty: add obstacles, narrow passages, reduce friction"],
                        ["70\u201390%", "Maintain difficulty, increase training epochs"],
                        ["50\u201370%", "Analyze failure modes, generate targeted remediation scenarios"],
                        ["< 50%", "Reduce difficulty, check for architecture issues, consider weight reset"],
                    ]
                ),

                new Paragraph({ children: [new PageBreak()] }),

                // ── 5. CLAUDE CODE SKILL ──
                heading("5. Claude Code Skill: Training Supervisor", HeadingLevel.HEADING_1),
                heading("5.1 Skill Definition", HeadingLevel.HEADING_2),
                para("A dedicated Claude Code skill (training-supervisor) connects the LLM to the MCP training server. " +
                    "It triggers on natural language requests related to training, scenario creation, and brain evaluation."),
                simpleTable(
                    ["Trigger Phrase", "Action"],
                    [
                        ["\"train the brain\"", "Run full curriculum (phases 1\u20135)"],
                        ["\"create scenarios for X\"", "Generate targeted scenarios via MCP"],
                        ["\"evaluate navigation\"", "Run brain_evaluate on standard test set"],
                        ["\"the rover fails on Y\"", "Analyze failure, generate remediation scenarios"],
                        ["\"export weights\"", "brain_export for deployment"],
                    ]
                ),

                heading("5.2 Skill Workflow", HeadingLevel.HEADING_2),
                para("When invoked, the skill follows this loop:"),
                bullet("Connect to MCP training server"),
                bullet("Assess current brain state (brain_evaluate on baseline scenarios)"),
                bullet("Identify weaknesses from failure mode analysis"),
                bullet("Generate targeted training scenarios"),
                bullet("Run training loops (supervised or evolutionary)"),
                bullet("Re-evaluate and compare metrics"),
                bullet("Report results and recommend next steps"),
                bullet("Optionally: export weights if quality threshold is met"),

                new Paragraph({ children: [new PageBreak()] }),

                // ── 6. SENSOR SIMULATION ──
                heading("6. Sensor Simulation for Training", HeadingLevel.HEADING_1),
                heading("6.1 Depth Sources", HeadingLevel.HEADING_2),
                para("Training data is generated from scenarios using pluggable sensor simulators:"),
                simpleTable(
                    ["Simulator", "Implementation", "Speed", "Fidelity"],
                    [
                        ["MathRaycaster", "Pure math ray-geometry intersection", "Fast (CPU)", "Perfect (no noise)"],
                        ["MathStereoSimulator", "Raycaster + noise + dropout model", "Fast (CPU)", "Approximate stereo errors"],
                        ["BabylonDepthReader", "GPU depth buffer via DepthRenderer", "GPU-accelerated", "Realistic rendering"],
                        ["CNN Matcher (planned)", "Learned stereo matching", "GPU", "Handles textureless surfaces"],
                    ]
                ),

                heading("6.2 The IDepthBufferProvider Abstraction", HeadingLevel.HEADING_2),
                para("All depth sources implement the same interface. The training pipeline and runtime " +
                    "consume an IDepthBuffer regardless of source. This allows:"),
                bullet("Training on cheap math-based depth, deploying with GPU depth"),
                bullet("Swapping stereo for LiDAR without changing downstream code"),
                bullet("Injecting noise models for robustness training"),

                heading("6.3 Convolution Pipeline", HeadingLevel.HEADING_2),
                para("Raw depth buffers are downsampled via convolution (average pooling) to produce " +
                    "fixed-size sector arrays consumed by the PerceptCortex. The convolution provider is " +
                    "also pluggable: pure math (CPU), Canvas/ImageData (browser), or GPU compute shader."),

                new Paragraph({ children: [new PageBreak()] }),

                // ── 7. PERCEPT OUTPUT ──
                heading("7. PerceptCortex Output Specification", HeadingLevel.HEADING_1),
                para("The 8 perception features, their ranges, and ground truth computation:"),
                simpleTable(
                    ["#", "Feature", "Range", "Ground Truth Formula"],
                    [
                        ["0", "frontObstacleProximity", "0.0 \u2192 1.0", "1 - min(frontSectors) / maxRange"],
                        ["1", "frontObstacleBearing", "-1.0 \u2192 +1.0", "Weighted angular centroid of front obstacles"],
                        ["2", "leftClearance", "0.0 \u2192 1.0", "avg(leftSectors) / maxRange"],
                        ["3", "rightClearance", "0.0 \u2192 1.0", "avg(rightSectors) / maxRange"],
                        ["4", "closingRate", "-1.0 \u2192 +1.0", "dot(imuAccel, frontVector) / maxAccel"],
                        ["5", "corridorDirection", "-1.0 \u2192 +1.0", "Direction of deepest sector, normalized"],
                        ["6", "terrainRoughness", "0.0 \u2192 1.0", "variance(imuAccel) / maxVariance"],
                        ["7", "confidence", "0.0 \u2192 1.0", "Sensor consistency metric"],
                    ]
                ),

                new Paragraph({ children: [new PageBreak()] }),

                // ── 8. IMPLEMENTATION ROADMAP ──
                heading("8. Implementation Roadmap", HeadingLevel.HEADING_1),
                simpleTable(
                    ["Phase", "Deliverable", "Depends On", "Status"],
                    [
                        ["0", "Core interfaces + MLP cascade brain", "\u2014", "Done"],
                        ["0", "Sensor interfaces (IMU, LiDAR, Wheel, Odometry)", "\u2014", "Done"],
                        ["0", "Differential odometry (N-wheel)", "\u2014", "Done"],
                        ["0", "Stereo vision interfaces + depth fusion", "Phase 0", "Done"],
                        ["0", "Configurable compute pipeline (PipelineBuilder)", "Phase 0", "Done"],
                        ["1", "MCP Training Server (McpTrainingBehavior)", "Phase 0", "Planned"],
                        ["1", "Scenario generator with MCP injection", "Phase 0", "Scaffolded"],
                        ["1", "Percept labeler (ground truth computation)", "Phase 0", "Scaffolded"],
                        ["2", "Claude Code skill: training-supervisor", "Phase 1", "Planned"],
                        ["2", "Curriculum learning orchestration", "Phase 1", "Planned"],
                        ["3", "CNN stereo matcher (spiky-panda-ext)", "Phase 0", "Planned"],
                        ["3", "Babylon sensor adapters (GPU depth)", "Phase 0", "Scaffolded"],
                        ["4", "End-to-end evaluation on Mars-like terrain", "Phase 1\u20133", "Planned"],
                    ]
                ),

                new Paragraph({ children: [new PageBreak()] }),

                // ── 9. OPEN QUESTIONS ──
                heading("9. Open Questions & Decisions", HeadingLevel.HEADING_1),
                simpleTable(
                    ["Question", "Options", "Current Leaning"],
                    [
                        ["CNN framework for stereo matching?", "spiky-panda extension / TensorFlow.js / ONNX runtime", "spiky-panda extension (keep stack unified)"],
                        ["Training data format?", "JSON / binary / protobuf", "Binary Float32Array for speed"],
                        ["How many scenarios per curriculum phase?", "100 / 500 / 1000+", "Start 200, LLM scales based on convergence"],
                        ["Evolutionary vs backprop for DecisionCortex?", "Pure evolutionary / hybrid / backprop with reward shaping", "Hybrid: supervised percept, evolutionary decision"],
                        ["Weight versioning?", "File-based / git LFS / MLflow", "File-based with JSON metadata"],
                        ["Multi-rover training (swarm)?", "Independent brains / shared percept / federated", "Phase 5+ consideration"],
                    ]
                ),

                // ── 10. REFERENCES ──
                heading("10. Related Documentation", HeadingLevel.HEADING_1),
                bullet("docs/navigation-architecture.md \u2014 Full navigation architecture with MLP cascade"),
                bullet("docs/stereo-vision.md \u2014 Stereo matching algorithms, limitations, fusion strategy"),
                bullet("docs/differential-odometry.md \u2014 N-wheel differential odometry algorithm"),
                bullet("packages/dev/core/ \u2014 Core interfaces and implementations"),
                bullet("packages/dev/training/ \u2014 Training pipeline, scenarios, labeling"),
                bullet("packages/dev/babylon/ \u2014 Babylon.js sensor adapters"),
                bullet("packages/dev/spiky-panda/ \u2014 Compute graph extensions (CNN planned)"),
            ]
        }
    ]
});

// ── Generate ───────────────────────────────────────────────
const outPath = process.argv[2] || "docs/murmuration-training-plan.docx";
Packer.toBuffer(doc).then(buffer => {
    fs.writeFileSync(outPath, buffer);
    console.log(`Generated: ${outPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
});
