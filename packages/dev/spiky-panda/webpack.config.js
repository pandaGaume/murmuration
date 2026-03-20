/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");

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
        "@dev/spiky-panda": path.resolve(__dirname, "src"),
    },
};

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
            library: { name, type: "umd" },
            globalObject: "globalThis",
        },
        module: {
            rules: [
                tsRule,
                { test: /\.js$/, resolve: { fullySpecified: false } },
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
        },
    };
}

module.exports = (_env, argv) => {
    const mode = argv.mode === "development" ? "development" : "production";
    return [makeBundle("SpikyPandaExt", "src/index.ts", "spiky-panda-ext.js", mode)];
};
