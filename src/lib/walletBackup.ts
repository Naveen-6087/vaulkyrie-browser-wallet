import { decryptString, encryptString, type EncryptedPayload } from "@/lib/crypto";
import { readWalletPersistedEnvelope, type PersistedWalletEnvelope } from "@/lib/walletPersistStorage";
import {
  pickPersistedWalletState,
  useWalletStore,
  type PersistedWalletState,
} from "@/store/walletStore";

const BACKUP_FILE_VERSION = 1;

export interface WalletBackupFile extends EncryptedPayload {
  kind: "vaulkyrie-wallet-backup";
  version: number;
  exportedAt: number;
}

export interface WalletBackupPreview {
  exportedAt: number;
  network: PersistedWalletState["network"];
  relayUrl: string;
  accounts: Array<{ name: string; publicKey: string }>;
  contactCount: number;
  policyProfileCount: number;
  privacyAccountCount: number;
  privacyReceiptCount: number;
  orchestrationActivityCount: number;
  recoverySessionCount: number;
}

function isWalletAccountArray(value: unknown): value is PersistedWalletState["accounts"] {
  return Array.isArray(value) && value.every((account) => {
    if (typeof account !== "object" || account === null) return false;
    const candidate = account as Record<string, unknown>;
    return (
      typeof candidate.name === "string" &&
      typeof candidate.publicKey === "string" &&
      typeof candidate.balance === "number" &&
      typeof candidate.isActive === "boolean"
    );
  });
}

function normalizeImportedState(state: PersistedWalletState): PersistedWalletState {
  const accounts = state.accounts.map((account, index) => ({
    ...account,
    isActive: state.activeAccount?.publicKey
      ? account.publicKey === state.activeAccount.publicKey
      : index === 0,
  }));
  const activeAccount = state.activeAccount ?? accounts[0] ?? null;

  return {
    ...state,
    isOnboarded: true,
    isLocked: true,
    accounts,
    activeAccount,
    failedUnlockAttempts: 0,
    lastUnlockFailureAt: null,
    unlockBlockedUntil: null,
  };
}

function validatePersistedWalletState(value: unknown): PersistedWalletState {
  if (typeof value !== "object" || value === null) {
    throw new Error("Backup payload is not a wallet state.");
  }

  const candidate = value as Partial<PersistedWalletState>;
  if (!isWalletAccountArray(candidate.accounts) || candidate.accounts.length === 0) {
    throw new Error("Backup does not contain any vault accounts.");
  }
  if (typeof candidate.isOnboarded !== "boolean" || typeof candidate.isLocked !== "boolean") {
    throw new Error("Backup is missing core wallet flags.");
  }
  if (typeof candidate.network !== "string" || typeof candidate.relayUrl !== "string") {
    throw new Error("Backup is missing network configuration.");
  }

  return normalizeImportedState({
    isOnboarded: candidate.isOnboarded,
    isLocked: candidate.isLocked,
    accounts: candidate.accounts,
    activeAccount: candidate.activeAccount ?? candidate.accounts[0] ?? null,
    network: candidate.network,
    relayUrl: candidate.relayUrl,
    dkgResults: candidate.dkgResults ?? {},
    vaultConfigs: candidate.vaultConfigs ?? {},
    passwordHash: candidate.passwordHash ?? null,
    passwordSalt: candidate.passwordSalt ?? null,
    failedUnlockAttempts: candidate.failedUnlockAttempts ?? 0,
    lastUnlockFailureAt: candidate.lastUnlockFailureAt ?? null,
    unlockBlockedUntil: candidate.unlockBlockedUntil ?? null,
    securityPreferences: candidate.securityPreferences ?? { autoLockMinutes: 5, lockOnHide: true },
    contacts: candidate.contacts ?? [],
    xmssTrees: candidate.xmssTrees ?? {},
    winterAuthorityStates: candidate.winterAuthorityStates ?? {},
    quantumVaultKeys: candidate.quantumVaultKeys ?? {},
    policyProfiles: candidate.policyProfiles ?? {},
    privacyAccounts: candidate.privacyAccounts ?? {},
    privacyReceipts: candidate.privacyReceipts ?? {},
    orchestrationHistory: candidate.orchestrationHistory ?? {},
    recoverySessions: candidate.recoverySessions ?? {},
  });
}

export async function exportEncryptedWalletBackup(password: string): Promise<WalletBackupFile> {
  const storedEnvelope = await readWalletPersistedEnvelope<PersistedWalletState>();
  const state = validatePersistedWalletState(
    pickPersistedWalletState(useWalletStore.getState()),
  );
  const encrypted = await encryptString(
    JSON.stringify({
      ...(storedEnvelope ?? {}),
      state,
    } satisfies PersistedWalletEnvelope<PersistedWalletState>),
    password,
  );

  return {
    kind: "vaulkyrie-wallet-backup",
    version: BACKUP_FILE_VERSION,
    exportedAt: Date.now(),
    ...encrypted,
  };
}

function parseWalletBackupFile(backupJson: string): WalletBackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(backupJson);
  } catch {
    throw new Error("Backup file is not valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Backup file is malformed.");
  }

  const candidate = parsed as Partial<WalletBackupFile>;
  if (candidate.kind !== "vaulkyrie-wallet-backup" || candidate.version !== BACKUP_FILE_VERSION) {
    throw new Error("Unsupported backup file format.");
  }
  if (
    typeof candidate.ciphertext !== "string" ||
    typeof candidate.iv !== "string" ||
    typeof candidate.salt !== "string" ||
    typeof candidate.iterations !== "number"
  ) {
    throw new Error("Backup file is missing encrypted payload fields.");
  }

  return candidate as WalletBackupFile;
}

async function decodeEncryptedWalletBackup(
  backupJson: string,
  password: string,
): Promise<{ backup: WalletBackupFile; restoredState: PersistedWalletState }> {
  const backup = parseWalletBackupFile(backupJson);

  let plaintext = "";
  try {
    plaintext = await decryptString(backup, password);
  } catch {
    throw new Error("Backup password is incorrect or the file is corrupted.");
  }

  let envelope: PersistedWalletEnvelope<PersistedWalletState>;
  try {
    envelope = JSON.parse(plaintext) as PersistedWalletEnvelope<PersistedWalletState>;
  } catch {
    throw new Error("Backup payload could not be decoded.");
  }

  return {
    backup,
    restoredState: validatePersistedWalletState(envelope.state),
  };
}

export async function previewEncryptedWalletBackup(
  backupJson: string,
  password: string,
): Promise<WalletBackupPreview> {
  const { backup, restoredState } = await decodeEncryptedWalletBackup(backupJson, password);

  return {
    exportedAt: backup.exportedAt,
    network: restoredState.network,
    relayUrl: restoredState.relayUrl,
    accounts: restoredState.accounts.map((account) => ({
      name: account.name,
      publicKey: account.publicKey,
    })),
    contactCount: restoredState.contacts.length,
    policyProfileCount: Object.values(restoredState.policyProfiles).reduce(
      (sum, profiles) => sum + profiles.length,
      0,
    ),
    privacyAccountCount: Object.values(restoredState.privacyAccounts).reduce(
      (sum, accounts) => sum + accounts.length,
      0,
    ),
    privacyReceiptCount: Object.values(restoredState.privacyReceipts).reduce(
      (sum, receipts) => sum + receipts.length,
      0,
    ),
    orchestrationActivityCount: Object.values(restoredState.orchestrationHistory).reduce(
      (sum, activities) => sum + activities.length,
      0,
    ),
    recoverySessionCount: Object.values(restoredState.recoverySessions).reduce(
      (sum, sessions) => sum + sessions.length,
      0,
    ),
  };
}

export async function importEncryptedWalletBackup(
  backupJson: string,
  password: string,
): Promise<PersistedWalletState> {
  const { restoredState } = await decodeEncryptedWalletBackup(backupJson, password);
  useWalletStore.setState({
    ...restoredState,
    currentView: "dashboard",
    pendingPolicyRequest: null,
    tokens: [],
    transactions: [],
    collectibles: [],
    vaultState: null,
    isLoading: false,
    error: null,
    lastFetchedAt: null,
  });

  return restoredState;
}
