import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const relayServerRoot = path.resolve(scriptDir, "..");
const sourceDir = path.resolve(relayServerRoot, "..", "src", "wasm", "vaulkyrie-frost-wasm");
const outputDir = path.resolve(relayServerRoot, "vendor", "vaulkyrie-frost-wasm");

if (!existsSync(sourceDir)) {
  throw new Error(`FROST WASM source directory not found: ${sourceDir}`);
}

mkdirSync(outputDir, { recursive: true });
cpSync(sourceDir, outputDir, { recursive: true, force: true });
console.log(`[relay-server] Copied FROST WASM assets to ${outputDir}`);
