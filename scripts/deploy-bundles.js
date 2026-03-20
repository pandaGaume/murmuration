import { existsSync, readdirSync, copyFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");

const sources = [
    join(root, "packages/dev/spiky-panda/bundle"),
    join(root, "packages/dev/core/bundle"),
    join(root, "packages/dev/babylon/bundle"),
    join(root, "packages/dev/training/bundle"),
];

const dest = join(root, "packages/host/www/lib");
mkdirSync(dest, { recursive: true });

let copied = 0;

for (const src of sources) {
    if (!existsSync(src)) {
        console.log(`  skip ${src} (not found)`);
        continue;
    }
    for (const file of readdirSync(src)) {
        if (file.endsWith(".js") || file.endsWith(".js.map")) {
            copyFileSync(join(src, file), join(dest, file));
            console.log(`  ${file} → ${dest}`);
            copied++;
        }
    }
}

console.log(`\ndeploy-bundles done. (${copied} files)`);
