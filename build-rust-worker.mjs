import { copyFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import process from "process";

const manifestPath = path.join("rust-worker", "Cargo.toml");
const result = spawnSync("cargo", ["build", "--manifest-path", manifestPath, "--release"], {
    stdio: "inherit",
});

if (result.status !== 0) {
    process.exit(result.status || 1);
}

const exeName = process.platform === "win32" ? "i18n-companion-worker.exe" : "i18n-companion-worker";
const source = path.join("rust-worker", "target", "release", exeName);
if (!existsSync(source)) {
    console.error(`Rust worker binary not found: ${source}`);
    process.exit(1);
}

copyFileSync(source, exeName);
console.log(`Copied ${source} -> ${exeName}`);
