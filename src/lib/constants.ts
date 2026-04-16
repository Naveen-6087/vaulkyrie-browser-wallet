export const NETWORKS = {
  mainnet: {
    name: "Mainnet",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    explorerUrl: "https://explorer.solana.com",
    color: "#14F195",
  },
  devnet: {
    name: "Devnet",
    rpcUrl: "https://api.devnet.solana.com",
    explorerUrl: "https://explorer.solana.com/?cluster=devnet",
    color: "#9945FF",
  },
  testnet: {
    name: "Testnet",
    rpcUrl: "https://api.testnet.solana.com",
    explorerUrl: "https://explorer.solana.com/?cluster=testnet",
    color: "#FFB84D",
  },
} as const;

export type NetworkId = keyof typeof NETWORKS;

export const DEFAULT_NETWORK: NetworkId = "devnet";

export const VAULKYRIE_CORE_PROGRAM_ID =
  "HUf5TWL4H18qJigd9m7h6MihX1xnzr2BVbbyGYFLEGPx";
export const VAULKYRIE_POLICY_MXE_PROGRAM_ID =
  "6XVfpzDXRDQXLHfvwkLA6So3WTriQfWQphsHzfWSSGr7";
