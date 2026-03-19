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

const resolve = {
    extensions: [".ts", ".tsx", ".js"],
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
        module: { rules: [tsRule] },
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

    return [makeBundle("MyOrgCore", "src/index.ts", "core.js", mode)];
};
