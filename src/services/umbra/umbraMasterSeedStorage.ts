import type { MasterSeedGeneratorFunction } from "@umbra-privacy/sdk";
import { assertMasterSeed, type MasterSeed } from "@umbra-privacy/sdk/types";
import type { GetUmbraClientDeps } from "@umbra-privacy/sdk";
import type { UmbraNetworkId } from "@/types";

async function loadUmbraMasterSeedForStorage(walletPublicKey: string, network: UmbraNetworkId) {
  const { loadUmbraMasterSeedInBackground } = await import("@/background/vaultSession");
  return loadUmbraMasterSeedInBackground(walletPublicKey, network);
}

async function storeUmbraMasterSeedForStorage(
  walletPublicKey: string,
  network: UmbraNetworkId,
  seed: Uint8Array,
): Promise<void> {
  const { storeUmbraMasterSeedInBackground } = await import("@/background/vaultSession");
  return storeUmbraMasterSeedInBackground(walletPublicKey, network, seed);
}

export function createBackgroundUmbraMasterSeedStorage(
  walletPublicKey: string,
  network: UmbraNetworkId,
  options?: {
    generate?: MasterSeedGeneratorFunction;
  },
): NonNullable<GetUmbraClientDeps["masterSeedStorage"]> {
  return {
    load: async () => {
      const result = await loadUmbraMasterSeedForStorage(walletPublicKey, network);
      if (!result.exists) {
        return { exists: false };
      }
      assertMasterSeed(result.seed);
      return { exists: true, seed: result.seed as MasterSeed };
    },
    generate: options?.generate ?? createRandomMasterSeedGenerator(),
    store: async (seed) => {
      try {
        await storeUmbraMasterSeedForStorage(walletPublicKey, network, Uint8Array.from(seed));
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to store Umbra master seed",
        };
      }
    },
  };
}

function createRandomMasterSeedGenerator(): MasterSeedGeneratorFunction {
  return async () => {
    const seed = crypto.getRandomValues(new Uint8Array(64));
    assertMasterSeed(seed);
    return seed as MasterSeed;
  };
}
