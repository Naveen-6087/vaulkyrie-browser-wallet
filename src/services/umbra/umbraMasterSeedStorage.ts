import type { MasterSeedGeneratorFunction } from "@umbra-privacy/sdk";
import { assertMasterSeed, type MasterSeed } from "@umbra-privacy/sdk/types";
import type { GetUmbraClientDeps } from "@umbra-privacy/sdk";
import type { UmbraNetworkId } from "@/types";
import {
  loadUmbraMasterSeedInBackground,
  storeUmbraMasterSeedInBackground,
} from "@/background/vaultSession";

export function createBackgroundUmbraMasterSeedStorage(
  walletPublicKey: string,
  network: UmbraNetworkId,
  options?: {
    generate?: MasterSeedGeneratorFunction;
  },
): NonNullable<GetUmbraClientDeps["masterSeedStorage"]> {
  return {
    load: async () => {
      const result = await loadUmbraMasterSeedInBackground(walletPublicKey, network);
      if (!result.exists) {
        return { exists: false };
      }
      assertMasterSeed(result.seed);
      return { exists: true, seed: result.seed as MasterSeed };
    },
    generate: options?.generate ?? createRandomMasterSeedGenerator(),
    store: async (seed) => {
      try {
        await storeUmbraMasterSeedInBackground(walletPublicKey, network, Uint8Array.from(seed));
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
