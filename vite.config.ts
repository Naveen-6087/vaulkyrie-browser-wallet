import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import { resolve } from "path";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [
    crx({ manifest }),
    react(),
    tailwindcss(),
    wasm(),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: [
      "buffer",
      "@solana/web3.js",
      "@solana/spl-token",
      "@solana/kit",
      "@umbra-privacy/sdk",
      "@umbra-privacy/umbra-codama",
      "@noble/hashes/sha2.js",
    ],
  },
  define: {
    "globalThis.process": JSON.stringify({ env: {} }),
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
});
