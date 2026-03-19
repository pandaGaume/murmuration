/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");

// ---------------------------------------------------------------------------
// Shared loader / resolver settings
// ---------------------------------------------------------------------------
const tsRule = {
    test: /\.tsx?$/,
    use: {
        loader: "ts-loader",
        options: {
            configFile: path.resolve(__dirname, "tsconfig.build.json"),
            transpileOnly: true,
        },
    },
    exclude: /node_modules/,
};

// Mirror tsconfig "paths": "@dev/core/*" → "../core/src/*".
// The externals function below prevents the resolved source from
// actually being bundled.
const resolve = {
    extensions: [".ts", ".tsx", ".js"],
    alias: {
        "@dev/core": path.resolve(__dirname, "..", "core", "src"),
    },
};

// ---------------------------------------------------------------------------
// Externals
// ---------------------------------------------------------------------------
// Static externals for third-party dependencies.
const staticExternals = {
    "@babylonjs/core": {
        commonjs: "@babylonjs/core",
        commonjs2: "@babylonjs/core",
        amd: "@babylonjs/core",
        root: "BABYLON",
    },
    "@spiky-panda/core": {
        commonjs: "@spiky-panda/core",
        commonjs2: "@spiky-panda/core",
        amd: "@spiky-panda/core",
        root: "SpikyPandaCore",
    },
    "murmuration-core": {
        commonjs: "murmuration-core",
        commonjs2: "murmuration-core",
        amd: "murmuration-core",
        root: "MurmurationCore",
    },
};

/**
 * Externals function that intercepts:
 *  - "core/..." path-alias imports  → mapped to "murmuration-core"
 *  - "@babylonjs/core/..."  deep imports  → mapped to "@babylonjs/core"
 *  - Any request that resolves into the core package source tree
 *
 * This ensures the babylon bundle contains ONLY its own adapter code;
 * everything else is expected at runtime from peer dependencies.
 */
function externalsHandler({ request, context }, callback) {
    // 1. Catch "@dev/core/perception", "@dev/core/simulation", "@dev/core/utils", etc.
    if (/^@dev\/core(\/|$)/.test(request)) {
        return callback(null, {
            commonjs: "murmuration-core",
            commonjs2: "murmuration-core",
            amd: "murmuration-core",
            root: "MurmurationCore",
        });
    }

    // 2. Catch deep @babylonjs/core imports like "@babylonjs/core/Maths/math.vector"
    if (/^@babylonjs\/core(\/|$)/.test(request)) {
        return callback(null, staticExternals["@babylonjs/core"]);
    }

    // 3. Catch @spiky-panda/core
    if (/^@spiky-panda\/core(\/|$)/.test(request)) {
        return callback(null, staticExternals["@spiky-panda/core"]);
    }

    // 4. Catch murmuration-core
    if (request === "murmuration-core") {
        return callback(null, staticExternals["murmuration-core"]);
    }

    // 5. Catch any resolved path that lands inside the core package source.
    //    This handles transitive imports that ts-loader resolved via the alias.
    const coreSourceDir = path.resolve(__dirname, "..", "core", "src");
    if (context && context.startsWith(coreSourceDir)) {
        return callback(null, {
            commonjs: "murmuration-core",
            commonjs2: "murmuration-core",
            amd: "murmuration-core",
            root: "MurmurationCore",
        });
    }

    callback();
}

// ---------------------------------------------------------------------------
// Bundle factory
// ---------------------------------------------------------------------------
/**
 * @param {string} name   Internal webpack name and UMD library name.
 * @param {string} entry  Entry-point path relative to this file.
 * @param {string} out    Output filename inside the `bundle/` directory.
 * @param {"production"|"development"} mode
 * @returns {import("webpack").Configuration}
 */
function makeBundle(name, entry, out, mode) {
    const isProd = mode === "production";
    return {
        name,
        mode,
        entry: path.resolve(__dirname, entry),
        target: "web",
        devtool: isProd ? "source-map" : "inline-source-map",
        output: {
            filename: out,
            path: path.resolve(__dirname, "bundle"),
            library: {
                name,
                type: "umd",
            },
            globalObject: "globalThis",
        },
        module: {
            rules: [
                tsRule,
                {
                    test: /\.js$/,
                    resolve: { fullySpecified: false },
                },
            ],
        },
        resolve,
        externals: [externalsHandler],
    };
}

// ---------------------------------------------------------------------------
// Multi-configuration export
// ---------------------------------------------------------------------------
/**
 * @param {Record<string, string>} _env   Webpack env vars (unused).
 * @param {{ mode?: string }}       argv  CLI arguments — carries `--mode`.
 * @returns {import("webpack").Configuration[]}
 */
module.exports = (_env, argv) => {
    const mode = /** @type {"production"|"development"} */ (argv.mode === "development" ? "development" : "production");

    return [makeBundle("MurmurationBabylon", "src/index.ts", "murmuration-babylon.js", mode)];
};
