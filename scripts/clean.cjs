const fs = require("fs");
const path = require("path");
const glob = require("path");

const root = path.resolve(__dirname, "..");

const dirs = [
    "packages/dev/core/dist",
    "packages/dev/core/bundle",
    "packages/dev/babylon/dist",
    "packages/dev/babylon/bundle",
    "packages/dev/training/dist",
    "packages/dev/training/bundle",
];

for (const d of dirs) {
    const full = path.join(root, d);
    fs.rmSync(full, { recursive: true, force: true });
}

// Remove tsbuildinfo files
for (const entry of fs.readdirSync(root)) {
    if (entry.endsWith(".tsbuildinfo")) {
        fs.rmSync(path.join(root, entry), { force: true });
    }
}

// Also check inside each package
const pkgRoot = path.join(root, "packages", "dev");
for (const pkg of fs.readdirSync(pkgRoot)) {
    const pkgDir = path.join(pkgRoot, pkg);
    if (!fs.statSync(pkgDir).isDirectory()) continue;
    for (const f of fs.readdirSync(pkgDir)) {
        if (f.endsWith(".tsbuildinfo")) {
            fs.rmSync(path.join(pkgDir, f), { force: true });
        }
    }
}

console.log("Clean done.");
