import { createSignerFromPrivateKeyBytes } from "@umbra-privacy/sdk";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { decryptString, encryptString } from "@/lib/crypto";
import {
  WALLET_STORAGE_KEY,
  readWalletPersistedEnvelope,
  writeWalletPersistedEnvelope,
} from "@/lib/walletPersistStorage";
import {
  isPrivacyVaultEncryptedKeyRecord,
  isUmbraEncryptedMasterSeedRecord,
  type PersistedWalletState,
  type PrivacyVaultEncryptedKeyRecord,
  type UmbraEncryptedMasterSeedRecord,
} from "@/store/walletStore";
import type { UmbraNetworkId } from "@/types";
import {
  backgroundWalletSessionState,
  readPersistedWalletState,
  requireUnlockedPassword,
} from "@/background/sessionState";

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

async function writePersistedWalletState(state: PersistedWalletState): Promise<void> {
  const existingEnvelope = await readWalletPersistedEnvelope<PersistedWalletState>(WALLET_STORAGE_KEY);
  await writeWalletPersistedEnvelope(
    {
      ...(existingEnvelope ?? {}),
      state,
    },
    WALLET_STORAGE_KEY,
  );
}

export async function createEncryptedPrivacyVaultKeyRecordInBackground(
  secretKey: Uint8Array,
): Promise<PrivacyVaultEncryptedKeyRecord> {
  const payload = await encryptString(bytesToBase64(secretKey), requireUnlockedPassword());
  return {
    kind: "privacy-vault-key",
    version: 1,
    ...payload,
  };
}

export async function createPrivacyVaultAccountInBackground(name: string) {
  const keypair = Keypair.generate();
  const keyRecord = await createEncryptedPrivacyVaultKeyRecordInBackground(keypair.secretKey);
  return {
    account: {
      name,
      publicKey: keypair.publicKey.toBase58(),
      balance: 0,
      isActive: true,
      kind: "privacy-vault" as const,
    },
    keyRecord,
  };
}

export async function loadPrivacyVaultSecretKeyInBackground(publicKey: string): Promise<Uint8Array> {
  const cached = backgroundWalletSessionState.privacyVaultSecrets.get(publicKey);
  if (cached) {
    return cached;
  }

  const state = await readPersistedWalletState();
  const record = state.privacyVaultKeys[publicKey];
  if (!record || !isPrivacyVaultEncryptedKeyRecord(record)) {
    throw new Error("No encrypted Privacy Vault key is stored for this account.");
  }

  const plaintext = await decryptString(record, requireUnlockedPassword());
  const secretKey = Uint8Array.from(Buffer.from(plaintext, "base64"));
  if (secretKey.length !== 64) {
    throw new Error("Stored Privacy Vault key is invalid.");
  }

  backgroundWalletSessionState.privacyVaultSecrets.set(publicKey, secretKey);
  return secretKey;
}

async function loadPrivacyVaultKeypairInBackground(publicKey: string): Promise<Keypair> {
  return Keypair.fromSecretKey(await loadPrivacyVaultSecretKeyInBackground(publicKey));
}

function assertLegacyWalletSigner(transaction: Transaction, walletPubkey: PublicKey) {
  const message = transaction.compileMessage();
  const signerMatched = message.accountKeys
    .slice(0, message.header.numRequiredSignatures)
    .some((publicKey) => publicKey.equals(walletPubkey));
  if (!signerMatched) {
    throw new Error("The active vault is not a required signer for this legacy transaction.");
  }
}

function assertVersionedWalletSigner(transaction: VersionedTransaction, walletPubkey: PublicKey) {
  const signerMatched = transaction.message.staticAccountKeys
    .slice(0, transaction.message.header.numRequiredSignatures)
    .some((publicKey) => publicKey.equals(walletPubkey));
  if (!signerMatched) {
    throw new Error("The active vault is not a required signer for this versioned transaction.");
  }
}

export async function signPrivacyVaultMessageInBackground(
  walletPublicKey: string,
  messageBytes: Uint8Array,
): Promise<Uint8Array> {
  const signer = await createSignerFromPrivateKeyBytes(await loadPrivacyVaultSecretKeyInBackground(walletPublicKey));
  const signed = await signer.signMessage(messageBytes);
  return Uint8Array.from(signed.signature);
}

export async function signPrivacyVaultTransactionInBackground(
  walletPublicKey: string,
  serializedTransactionBase64: string,
  kind: "legacy" | "versioned",
): Promise<{ signedTransaction: string; kind: "legacy" | "versioned" }> {
  const walletPubkey = new PublicKey(walletPublicKey);
  const rawBytes = Buffer.from(serializedTransactionBase64, "base64");
  const keypair = await loadPrivacyVaultKeypairInBackground(walletPublicKey);

  if (kind === "versioned") {
    const transaction = VersionedTransaction.deserialize(rawBytes);
    assertVersionedWalletSigner(transaction, walletPubkey);
    transaction.sign([keypair]);
    return {
      signedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
      kind,
    };
  }

  const transaction = Transaction.from(rawBytes);
  assertLegacyWalletSigner(transaction, walletPubkey);
  transaction.partialSign(keypair);
  return {
    signedTransaction: Buffer.from(
      transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }),
    ).toString("base64"),
    kind,
  };
}

function umbraSeedStorageKey(walletPublicKey: string, network: UmbraNetworkId): string {
  return `${walletPublicKey}:${network}`;
}

async function encryptUmbraMasterSeed(
  seed: Uint8Array,
): Promise<UmbraEncryptedMasterSeedRecord> {
  const payload = await encryptString(bytesToBase64(seed), requireUnlockedPassword());
  return {
    kind: "umbra-master-seed",
    version: 1,
    ...payload,
  };
}

export async function loadUmbraMasterSeedInBackground(
  walletPublicKey: string,
  network: UmbraNetworkId,
): Promise<{ exists: false } | { exists: true; seed: Uint8Array }> {
  const cacheKey = umbraSeedStorageKey(walletPublicKey, network);
  const cached = backgroundWalletSessionState.umbraMasterSeeds.get(cacheKey);
  if (cached) {
    return { exists: true, seed: cached };
  }

  const state = await readPersistedWalletState();
  const stored = state.umbraMasterSeeds[cacheKey];
  if (!stored) {
    return { exists: false };
  }

  let seed: Uint8Array;
  if (isUmbraEncryptedMasterSeedRecord(stored)) {
    const plaintext = await decryptString(stored, requireUnlockedPassword());
    seed = base64ToBytes(plaintext);
  } else {
    seed = base64ToBytes(stored);
    state.umbraMasterSeeds[cacheKey] = await encryptUmbraMasterSeed(seed);
    await writePersistedWalletState(state);
  }

  backgroundWalletSessionState.umbraMasterSeeds.set(cacheKey, seed);
  return { exists: true, seed };
}

export async function storeUmbraMasterSeedInBackground(
  walletPublicKey: string,
  network: UmbraNetworkId,
  seed: Uint8Array,
): Promise<void> {
  const cacheKey = umbraSeedStorageKey(walletPublicKey, network);
  const state = await readPersistedWalletState();
  state.umbraMasterSeeds[cacheKey] = await encryptUmbraMasterSeed(seed);
  await writePersistedWalletState(state);
  backgroundWalletSessionState.umbraMasterSeeds.set(cacheKey, seed);
}
