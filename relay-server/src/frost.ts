import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface FrostWasmModule {
  __wbg_set_wasm: (exports: WebAssembly.Exports) => void;
  signing_round1: (participantId: number, keyPackageJson: string) => string;
  signing_round2: (
    participantId: number,
    noncesJson: string,
    keyPackageJson: string,
    message: Uint8Array,
    commitmentsJson: string,
  ) => string;
}

let wasmPromise: Promise<FrostWasmModule> | null = null;

function resolveWasmDir(): string {
  const candidates = [
    process.env.FROST_WASM_DIR,
    path.resolve(process.cwd(), "../src/wasm/vaulkyrie-frost-wasm"),
    path.resolve(process.cwd(), "src/wasm/vaulkyrie-frost-wasm"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const match = candidates.find((candidate) =>
    existsSync(path.join(candidate, "vaulkyrie_frost_wasm_bg.js")) &&
    existsSync(path.join(candidate, "vaulkyrie_frost_wasm_bg.wasm")),
  );

  if (!match) {
    throw new Error("Could not locate Vaulkyrie FROST WASM package. Set FROST_WASM_DIR.");
  }

  return match;
}

export async function loadFrostWasm(): Promise<FrostWasmModule> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const wasmDir = resolveWasmDir();
      const bgPath = path.join(wasmDir, "vaulkyrie_frost_wasm_bg.js");
      const wasmPath = path.join(wasmDir, "vaulkyrie_frost_wasm_bg.wasm");
      const bg = (await import(pathToFileURL(bgPath).href)) as FrostWasmModule;
      const wasmBytes = readFileSync(wasmPath);
      const { instance } = await WebAssembly.instantiate(wasmBytes, {
        "./vaulkyrie_frost_wasm_bg.js": bg as unknown as WebAssembly.ModuleImports,
      });
      bg.__wbg_set_wasm(instance.exports);
      const start = instance.exports.__wbindgen_start;
      if (typeof start === "function") {
        start();
      }
      return bg;
    })();
  }

  return wasmPromise;
}
