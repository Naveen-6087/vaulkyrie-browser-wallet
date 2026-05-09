import { defineManifest } from "@crxjs/vite-plugin";

const LOCAL_RELAY_HTTP_ORIGINS = [
  "http://localhost:8765",
  "http://127.0.0.1:8765",
] as const;

const LOCAL_RELAY_WS_ORIGINS = [
  "ws://localhost:8765",
  "ws://127.0.0.1:8765",
] as const;

const DEFAULT_MANAGED_RELAY_URL = "wss://relay.vaulkyrie.xyz";
const STATIC_CONNECT_ORIGINS = [
  "https://www.vaulkyrie.xyz",
  "https://vaulkyrie.mintlify.app",
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://api.devnet.solana.com",
  "https://api.testnet.solana.com",
] as const;

function getRelayOrigins() {
  const configuredRelayUrl = process.env.VITE_RELAY_URL?.trim() || DEFAULT_MANAGED_RELAY_URL;

  try {
    const relayUrl = new URL(configuredRelayUrl);
    const relayHttpProtocol = relayUrl.protocol === "wss:" ? "https:" : "http:";
    const relayHttpOrigin = `${relayHttpProtocol}//${relayUrl.host}`;

    return {
      connectOrigins: [relayHttpOrigin, relayUrl.origin],
      hostPermissions: [`${relayHttpOrigin}/*`],
    };
  } catch {
    return {
      connectOrigins: ["https://relay.vaulkyrie.xyz", "wss://relay.vaulkyrie.xyz"],
      hostPermissions: ["https://relay.vaulkyrie.xyz/*"],
    };
  }
}

const relayOrigins = getRelayOrigins();
const extensionPageCsp = [
  "script-src 'self' 'wasm-unsafe-eval'",
  "object-src 'self'",
  "base-uri 'self'",
  `connect-src 'self' ${[
    ...LOCAL_RELAY_HTTP_ORIGINS,
    ...LOCAL_RELAY_WS_ORIGINS,
    ...relayOrigins.connectOrigins,
    ...STATIC_CONNECT_ORIGINS,
  ].join(" ")}`,
].join("; ");

export default defineManifest({
  manifest_version: 3,
  name: "Vaulkyrie Wallet",
  description: "Solana threshold wallet with post-quantum security",
  version: "0.1.0",
  icons: {
    "16": "logo.png",
    "48": "logo.png",
    "128": "logo.png",
  },
  action: {
    default_popup: "index.html",
    default_icon: {
      "16": "logo.png",
      "48": "logo.png",
    },
    default_title: "Vaulkyrie Wallet",
  },
  background: {
    service_worker: "src/background/index.ts",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_start",
    },
  ],
  web_accessible_resources: [
    {
      resources: ["src/injected/index.ts"],
      matches: ["<all_urls>"],
    },
  ],
  permissions: ["storage", "activeTab", "notifications"],
  content_security_policy: {
    extension_pages: extensionPageCsp,
  },
  host_permissions: [
    ...LOCAL_RELAY_HTTP_ORIGINS.map((origin) => `${origin}/*`),
    ...relayOrigins.hostPermissions,
    "https://www.vaulkyrie.xyz/*",
    "https://vaulkyrie.mintlify.app/*",
    "https://api.mainnet-beta.solana.com/*",
    "https://solana-rpc.publicnode.com/*",
    "https://api.devnet.solana.com/*",
    "https://api.testnet.solana.com/*",
  ],
});
