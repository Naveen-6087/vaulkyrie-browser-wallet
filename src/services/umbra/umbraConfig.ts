import type { NetworkId } from "@/lib/constants";
import { NETWORKS } from "@/lib/constants";
import type { UmbraNetworkId } from "@/types";

export interface UmbraTokenConfig {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  icon?: string;
}

export interface UmbraClientNetworkConfig {
  network: UmbraNetworkId;
  rpcUrl: string;
  rpcSubscriptionsUrl: string;
  indexerApiEndpoint?: string;
  relayerApiEndpoint?: string;
}

export const UMBRA_SUPPORTED_TOKENS: Record<UmbraNetworkId, UmbraTokenConfig[]> = {
  mainnet: [
    {
      symbol: "USDC",
      name: "USD Coin",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
      icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
    },
    {
      symbol: "USDT",
      name: "Tether USD",
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      decimals: 6,
      icon: "https://assets.coingecko.com/coins/images/325/small/Tether.png",
    },
    {
      symbol: "wSOL",
      name: "Wrapped SOL",
      mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
      icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
    },
    {
      symbol: "UMBRA",
      name: "Umbra",
      mint: "PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta",
      decimals: 6,
      icon: "https://sdk.umbraprivacy.com/favicon.svg",
    },
  ],
  devnet: [
    {
      symbol: "wSOL",
      name: "Wrapped SOL",
      mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
      icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
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
    indexerApiEndpoint: getUmbraIndexerEndpoint(umbraNetwork),
    relayerApiEndpoint: getUmbraRelayerEndpoint(umbraNetwork),
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

function getUmbraIndexerEndpoint(network: UmbraNetworkId): string | undefined {
  const configured = import.meta.env.VITE_UMBRA_INDEXER_URL?.trim();
  if (configured) return configured;

  if (network === "mainnet") return "https://utxo-indexer.api.umbraprivacy.com";
  if (network === "devnet") return "https://utxo-indexer.api-devnet.umbraprivacy.com";
  return undefined;
}

function getUmbraRelayerEndpoint(network: UmbraNetworkId): string | undefined {
  const configured = import.meta.env.VITE_UMBRA_RELAYER_URL?.trim();
  if (configured) return configured;

  if (network === "mainnet") return "https://relayer.api.umbraprivacy.com";
  if (network === "devnet") return "https://relayer.api-devnet.umbraprivacy.com";
  return undefined;
}
