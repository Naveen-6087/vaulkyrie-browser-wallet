import { verifyPassword } from "@/lib/crypto";
import {
  WALLET_STORAGE_KEY,
  readWalletPersistedEnvelope,
} from "@/lib/walletPersistStorage";
import type { PersistedWalletState } from "@/store/walletStore";

export const backgroundWalletSessionState = {
  password: null as string | null,
  privacyVaultSecrets: new Map<string, Uint8Array>(),
  umbraMasterSeeds: new Map<string, Uint8Array>(),
};

export function requireUnlockedPassword(): string {
  if (!backgroundWalletSessionState.password) {
    throw new Error("Vaulkyrie is locked. Unlock the wallet before using local secrets.");
  }
  return backgroundWalletSessionState.password;
}

export async function readPersistedWalletState(): Promise<PersistedWalletState> {
  const envelope = await readWalletPersistedEnvelope<PersistedWalletState>(WALLET_STORAGE_KEY);
  if (!envelope?.state) {
    throw new Error("Vaulkyrie wallet state is not available yet.");
  }
  return envelope.state;
}

export function isWalletSessionUnlocked(): boolean {
  return backgroundWalletSessionState.password !== null;
}

export function setWalletSessionPasswordInBackground(password: string): void {
  backgroundWalletSessionState.password = password;
  backgroundWalletSessionState.privacyVaultSecrets.clear();
  backgroundWalletSessionState.umbraMasterSeeds.clear();
}

export async function unlockWalletSessionInBackground(password: string): Promise<void> {
  const state = await readPersistedWalletState();
  if (!state.passwordHash || !state.passwordSalt) {
    throw new Error("Set a wallet password before unlocking Vaulkyrie.");
  }
  const valid = await verifyPassword(password, state.passwordHash, state.passwordSalt);
  if (!valid) {
    throw new Error("Incorrect password");
  }
  setWalletSessionPasswordInBackground(password);
}

export function lockWalletSessionInBackground(): void {
  backgroundWalletSessionState.password = null;
  backgroundWalletSessionState.privacyVaultSecrets.clear();
  backgroundWalletSessionState.umbraMasterSeeds.clear();
}
