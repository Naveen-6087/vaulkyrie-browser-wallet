import type { NetworkId } from "@/lib/constants";
import { NETWORKS } from "@/lib/constants";
import type { UmbraNetworkId } from "@/types";

export interface UmbraTokenConfig {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
}

export interface UmbraClientNetworkConfig {
  network: UmbraNetworkId;
  rpcUrl: string;
  rpcSubscriptionsUrl: string;
}

export const UMBRA_SUPPORTED_TOKENS: Record<UmbraNetworkId, UmbraTokenConfig[]> = {
  mainnet: [
    {
      symbol: "USDC",
      name: "USD Coin",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
    },
    {
      symbol: "USDT",
      name: "Tether USD",
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      decimals: 6,
    },
    {
      symbol: "wSOL",
      name: "Wrapped SOL",
      mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
    },
    {
      symbol: "UMBRA",
      name: "Umbra",
      mint: "PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta",
      decimals: 6,
    },
  ],
  devnet: [
    {
      symbol: "wSOL",
      name: "Wrapped SOL",
      mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
    },
  ],
  localnet: [],
};

export function toUmbraNetwork(network: NetworkId): UmbraNetworkId {
  if (network === "mainnet" || network === "devnet") {
    return network;
  }

  throw new Error("Umbra privacy mode is currently available on Mainnet and Devnet only.");
}

export function getUmbraClientNetworkConfig(network: NetworkId): UmbraClientNetworkConfig {
  const umbraNetwork = toUmbraNetwork(network);
  const rpcUrl = NETWORKS[network].rpcUrl;
  return {
    network: umbraNetwork,
    rpcUrl,
    rpcSubscriptionsUrl: toWebsocketRpcUrl(rpcUrl),
  };
}

export function getUmbraTokens(network: NetworkId): UmbraTokenConfig[] {
  const umbraNetwork = toUmbraNetwork(network);
  return UMBRA_SUPPORTED_TOKENS[umbraNetwork];
}

function toWebsocketRpcUrl(rpcUrl: string): string {
  if (rpcUrl.startsWith("https://")) {
    return rpcUrl.replace("https://", "wss://");
  }
  if (rpcUrl.startsWith("http://")) {
    return rpcUrl.replace("http://", "ws://");
  }
  return rpcUrl;
}
