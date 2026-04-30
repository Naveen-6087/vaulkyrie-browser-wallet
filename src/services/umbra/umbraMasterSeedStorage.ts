import { assertMasterSeed, type MasterSeed, type MasterSeedGeneratorFunction } from "@umbra-privacy/sdk/types";
import type { GetUmbraClientDeps } from "@umbra-privacy/sdk";
import type { UmbraNetworkId } from "@/types";
import { useWalletStore } from "@/store/walletStore";

export function createUmbraMasterSeedStorage(
  walletPublicKey: string,
  network: UmbraNetworkId,
): NonNullable<GetUmbraClientDeps["masterSeedStorage"]> {
  return {
    load: async () => {
      const encoded = useWalletStore.getState().getUmbraMasterSeed(walletPublicKey, network);
      if (!encoded) {
        return { exists: false };
      }

      const seed = base64ToBytes(encoded);
      assertMasterSeed(seed);
      return { exists: true, seed };
    },
    generate: createRandomMasterSeedGenerator(),
    store: async (seed) => {
      try {
        useWalletStore.getState().storeUmbraMasterSeed(walletPublicKey, network, bytesToBase64(seed));
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
