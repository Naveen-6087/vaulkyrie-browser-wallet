import type { NetworkId } from "@/lib/constants";
import { DEFAULT_NETWORK } from "@/lib/constants";
import {
  WALLET_STORAGE_KEY,
  readWalletPersistedEnvelope,
} from "@/lib/walletPersistStorage";

interface PersistedAccount {
  publicKey: string;
  name?: string;
}

interface PersistedWalletState {
  isOnboarded?: boolean;
  isLocked?: boolean;
  activeAccount?: PersistedAccount | null;
  accounts?: PersistedAccount[];
  network?: NetworkId;
}

export interface ExtensionProviderState {
  connected: boolean;
  publicKey: string | null;
  accountLabel: string | null;
  accounts: string[];
  network: NetworkId;
  isOnboarded: boolean;
  isLocked: boolean;
}

export async function readExtensionProviderState(): Promise<ExtensionProviderState> {
  const envelope = await readWalletPersistedEnvelope<PersistedWalletState>(WALLET_STORAGE_KEY);
  const state = envelope?.state;
  const activeAccount = state?.activeAccount ?? null;

  return {
    connected: Boolean(activeAccount?.publicKey),
    publicKey: activeAccount?.publicKey ?? null,
    accountLabel: activeAccount?.name ?? null,
    accounts: (state?.accounts ?? []).map((account) => account.publicKey),
    network: state?.network ?? DEFAULT_NETWORK,
    isOnboarded: Boolean(state?.isOnboarded),
    isLocked: Boolean(state?.isLocked),
  };
}
