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

// Mirror tsconfig "paths" so webpack can resolve the same aliases.
// "@dev/core/*" → "src/*" within this package.
const resolve = {
    extensions: [".ts", ".tsx", ".js"],
    alias: {
        "@dev/core": path.resolve(__dirname, "src"),
        "@dev/spiky-panda": path.resolve(__dirname, "../spiky-panda/src"),
    },
};

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
                // @spiky-panda/core is ESM — webpack enforces fully-specified
                // imports (e.g. './utils' must be './utils/index.js'). This rule
                // disables that requirement for .js files in node_modules.
                {
                    test: /\.js$/,
                    resolve: { fullySpecified: false },
                },
            ],
        },
        resolve,
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

    return [makeBundle("MurmurationCore", "src/index.ts", "murmuration-core.js", mode)];
};
