/**
 * Shared transaction and message signing helpers for Vaulkyrie accounts.
 *
 * Threshold Vaults keep the existing FROST path, while Privacy Vaults use a
 * locally decrypted Ed25519 signer.
 */

import { PublicKey, Transaction, VersionedTransaction, type Connection } from "@solana/web3.js";
import { Buffer } from "buffer";
import { getWalletAccountKind } from "@/lib/walletAccounts";
import {
  signPrivacyVaultMessageInBackground,
  signPrivacyVaultTransactionInBackground,
} from "@/lib/internalWalletRpc";
import { signLocal, hexToBytes } from "./frostService";
import { useWalletStore } from "@/store/walletStore";
import type { VaultCosignerMetadata } from "@/services/cosigner/cosignerClient";

interface DkgResult {
  groupPublicKeyHex: string;
  publicKeyPackage: string;
  keyPackages: Record<number, string>;
  threshold: number;
  participants: number;
  participantId?: number;
  isMultiDevice?: boolean;
  cosigner?: VaultCosignerMetadata | null;
}

/**
 * Load the DKG result for a given public key, migrating from sessionStorage
 * if necessary.
 */
export function loadDkgResult(publicKey: string): DkgResult {
  const { getDkgResult, storeDkgResult } = useWalletStore.getState();
  let dkg = getDkgResult(publicKey);

  if (!dkg && typeof sessionStorage !== "undefined") {
    const dkgJson = sessionStorage.getItem("vaulkyrie_dkg_result");
    if (dkgJson) {
      const parsed = JSON.parse(dkgJson);
      dkg = {
        groupPublicKeyHex: parsed.groupPublicKeyHex ?? "",
        publicKeyPackage: parsed.publicKeyPackage ?? "",
        keyPackages: parsed.keyPackages ?? {},
        threshold: parsed.threshold ?? 2,
        participants: parsed.participants ?? 3,
        participantId: parsed.participantId,
        isMultiDevice: parsed.isMultiDevice,
        cosigner: parsed.cosigner ?? null,
        createdAt: Date.now(),
      };
      storeDkgResult(publicKey, dkg);
      sessionStorage.removeItem("vaulkyrie_dkg_result");
    }
  }

  if (!dkg) {
    throw new Error("No DKG key packages found. Run DKG ceremony first.");
  }

  return dkg;
}

export type SerializedTransactionKind = "legacy" | "versioned";

export function assertLegacyWalletSigner(transaction: Transaction, walletPubkey: PublicKey) {
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

function isPrivacyVaultPublicKey(walletPubkey: string): boolean {
  const account = useWalletStore.getState().accounts.find((candidate) => candidate.publicKey === walletPubkey);
  return getWalletAccountKind(account) === "privacy-vault";
}

async function signPrivacyVaultMessage(
  walletPubkey: string,
  messageBytes: Uint8Array,
): Promise<Uint8Array> {
  const result = await signPrivacyVaultMessageInBackground({
    walletPublicKey: walletPubkey,
    message: Buffer.from(messageBytes).toString("base64"),
  });
  return Uint8Array.from(Buffer.from(result.signature, "base64"));
}

export async function signThresholdMessage(
  walletPubkey: string,
  messageBytes: Uint8Array,
): Promise<Uint8Array> {
  const dkg = loadDkgResult(walletPubkey);

  const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
  const hasLocalThreshold = availableKeyIds.length >= dkg.threshold;

  if (!hasLocalThreshold) {
    throw new Error(
      `This device only has ${availableKeyIds.length} of ${dkg.threshold} required key packages. ` +
        "Use the multi-device signing ceremony or sign from a device with enough local shares."
    );
  }

  const signerIds = availableKeyIds.slice(0, dkg.threshold);
  const result = await signLocal(
    messageBytes,
    dkg.keyPackages,
    dkg.publicKeyPackage,
    signerIds,
  );

  if (!result.verified) {
    throw new Error("FROST signature verification failed");
  }

  return hexToBytes(result.signatureHex);
}

export async function prepareLegacyVaultTransaction(
  connection: Connection,
  tx: Transaction,
  walletPubkey: string,
): Promise<PublicKey> {
  const fromPubkey = new PublicKey(walletPubkey);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;
  assertLegacyWalletSigner(tx, fromPubkey);
  return fromPubkey;
}

export async function sendSignedLegacyVaultTransaction(
  connection: Connection,
  tx: Transaction,
  walletPubkey: string,
  signatureBytes: Uint8Array,
): Promise<string> {
  const fromPubkey = new PublicKey(walletPubkey);
  tx.addSignature(fromPubkey, Buffer.from(signatureBytes));
  const rawTx = tx.serialize();
  return connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
}

export async function signSerializedTransaction(
  serializedTransactionBase64: string,
  walletPubkey: string,
  kind: SerializedTransactionKind,
): Promise<{ signedTransactionBase64: string; kind: SerializedTransactionKind }> {
  const fromPubkey = new PublicKey(walletPubkey);
  const rawBytes = Buffer.from(serializedTransactionBase64, "base64");
  const usePrivacyVaultSigner = isPrivacyVaultPublicKey(walletPubkey);

  if (kind === "versioned") {
    const transaction = VersionedTransaction.deserialize(rawBytes);
    assertVersionedWalletSigner(transaction, fromPubkey);
    if (usePrivacyVaultSigner) {
      const signed = await signPrivacyVaultTransactionInBackground({
        walletPublicKey: walletPubkey,
        serializedTransaction: serializedTransactionBase64,
        kind,
      });
      return {
        signedTransactionBase64: signed.signedTransaction,
        kind: signed.kind,
      };
    } else {
      const signatureBytes = await signThresholdMessage(
        walletPubkey,
        transaction.message.serialize(),
      );
      transaction.addSignature(fromPubkey, signatureBytes);
    }
    return {
      signedTransactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
      kind,
    };
  }

  const transaction = Transaction.from(rawBytes);
  assertLegacyWalletSigner(transaction, fromPubkey);
  if (usePrivacyVaultSigner) {
    const signed = await signPrivacyVaultTransactionInBackground({
      walletPublicKey: walletPubkey,
      serializedTransaction: serializedTransactionBase64,
      kind,
    });
    return {
      signedTransactionBase64: signed.signedTransaction,
      kind: signed.kind,
    };
  } else {
    const signatureBytes = await signThresholdMessage(
      walletPubkey,
      transaction.serializeMessage(),
    );
    transaction.addSignature(fromPubkey, Buffer.from(signatureBytes));
  }
  return {
    signedTransactionBase64: Buffer.from(
      transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }),
    ).toString("base64"),
    kind,
  };
}

export async function signMessageBytes(
  walletPubkey: string,
  messageBytes: Uint8Array,
): Promise<Uint8Array> {
  if (isPrivacyVaultPublicKey(walletPubkey)) {
    return signPrivacyVaultMessage(walletPubkey, messageBytes);
  }
  return signThresholdMessage(walletPubkey, messageBytes);
}

/**
 * Sign a pre-built transaction with the active Vaulkyrie account and submit it.
 *
 * Threshold Vaults use the local-or-cosigner threshold flow. Privacy Vaults use
 * the locally stored signer that is decrypted with the live wallet password.
 */
export async function signAndSendTransaction(
  connection: Connection,
  tx: Transaction,
  walletPubkey: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const fromPubkey = await prepareLegacyVaultTransaction(connection, tx, walletPubkey);
  if (isPrivacyVaultPublicKey(walletPubkey)) {
    onProgress?.("Signing with Privacy Vault key...");
    const signed = await signPrivacyVaultTransactionInBackground({
      walletPublicKey: walletPubkey,
      serializedTransaction: Buffer.from(
        tx.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
      ).toString("base64"),
      kind: "legacy",
    });
    onProgress?.("Submitting to Solana...");
    const rawTx = Buffer.from(signed.signedTransaction, "base64");
    return connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
  }

  onProgress?.("Signing with threshold key...");
  const { signThresholdMessageWithCosigner } = await import("./cosignerThresholdSigner");
  const signatureBytes = await signThresholdMessageWithCosigner(
    walletPubkey,
    tx.serializeMessage(),
    onProgress,
  );

  onProgress?.("Submitting to Solana...");
  return sendSignedLegacyVaultTransaction(connection, tx, fromPubkey.toBase58(), signatureBytes);
}

export async function signAndSendVersionedTransaction(
  connection: Connection,
  serializedTransactionBase64: string,
  walletPubkey: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const fromPubkey = new PublicKey(walletPubkey);
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(serializedTransactionBase64, "base64"),
  );
  assertVersionedWalletSigner(transaction, fromPubkey);

  onProgress?.("Signing swap transaction...");
  if (isPrivacyVaultPublicKey(walletPubkey)) {
    const signed = await signPrivacyVaultTransactionInBackground({
      walletPublicKey: walletPubkey,
      serializedTransaction: serializedTransactionBase64,
      kind: "versioned",
    });
    onProgress?.("Submitting to Solana...");
    return connection.sendRawTransaction(Buffer.from(signed.signedTransaction, "base64"), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
  } else {
    const signatureBytes = await signThresholdMessage(
      walletPubkey,
      transaction.message.serialize(),
    );
    transaction.addSignature(fromPubkey, signatureBytes);
  }

  onProgress?.("Submitting to Solana...");
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  return signature;
}
