import type { NetworkId } from "@/lib/constants";
import type { WalletAccountKind } from "@/types";
import { isWalletSessionUnlocked } from "@/background/sessionState";
import { DEFAULT_NETWORK } from "@/lib/constants";
import {
  WALLET_STORAGE_KEY,
  readWalletPersistedEnvelope,
} from "@/lib/walletPersistStorage";

interface PersistedAccount {
  publicKey: string;
  name?: string;
  kind?: WalletAccountKind;
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
  accountKind: WalletAccountKind | null;
  accounts: string[];
  network: NetworkId;
  isOnboarded: boolean;
  isLocked: boolean;
}

export function redactExtensionProviderState(): ExtensionProviderState {
  return {
    connected: false,
    publicKey: null,
    accountLabel: null,
    accountKind: null,
    accounts: [],
    network: DEFAULT_NETWORK,
    isOnboarded: false,
    isLocked: false,
  };
}

export async function readExtensionProviderState(): Promise<ExtensionProviderState> {
  const envelope = await readWalletPersistedEnvelope<PersistedWalletState>(WALLET_STORAGE_KEY);
  const state = envelope?.state;
  const activeAccount = state?.activeAccount ?? null;
  const sessionUnlocked = isWalletSessionUnlocked();
  const walletLocked = Boolean(state?.isOnboarded) && (Boolean(state?.isLocked) || !sessionUnlocked);

  return {
    connected: Boolean(activeAccount?.publicKey),
    publicKey: activeAccount?.publicKey ?? null,
    accountLabel: activeAccount?.name ?? null,
    accountKind: activeAccount?.kind ?? null,
    accounts: (state?.accounts ?? []).map((account) => account.publicKey),
    network: state?.network ?? DEFAULT_NETWORK,
    isOnboarded: Boolean(state?.isOnboarded),
    isLocked: walletLocked,
  };
}
