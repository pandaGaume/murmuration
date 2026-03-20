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
    alias: {
        "@dev/training": path.resolve(__dirname, "src"),
        "@dev/core": path.resolve(__dirname, "../core/src"),
        "@dev/spiky-panda": path.resolve(__dirname, "../spiky-panda/src"),
    },
};

// ---------------------------------------------------------------------------
// Bundle factory
// ---------------------------------------------------------------------------
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
        externals: {
            "@spiky-panda/core": {
                commonjs: "@spiky-panda/core",
                commonjs2: "@spiky-panda/core",
                amd: "@spiky-panda/core",
                root: "SpikyPanda",
            },
            "murmuration-core": {
                commonjs: "murmuration-core",
                commonjs2: "murmuration-core",
                amd: "murmuration-core",
                root: "MurmurationCore",
            },
        },
    };
}

// ---------------------------------------------------------------------------
// Multi-configuration export
// ---------------------------------------------------------------------------
module.exports = (_env, argv) => {
    const mode = /** @type {"production"|"development"} */ (argv.mode === "development" ? "development" : "production");

    return [makeBundle("MurmurationTraining", "src/index.ts", "murmuration-training.js", mode)];
};
