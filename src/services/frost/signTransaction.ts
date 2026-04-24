/**
 * Shared utility for FROST-signing a Solana Transaction.
 *
 * Encapsulates the single-device (local) signing path used across
 * SendView, PolicyView, and any future view that submits transactions
 * from the vault's threshold key.
 */

import { PublicKey, Transaction, VersionedTransaction, type Connection } from "@solana/web3.js";
import { Buffer } from "buffer";
import { signLocal, hexToBytes } from "./frostService";
import { useWalletStore } from "@/store/walletStore";

interface DkgResult {
  groupPublicKeyHex: string;
  publicKeyPackage: string;
  keyPackages: Record<number, string>;
  threshold: number;
  participants: number;
  participantId?: number;
  isMultiDevice?: boolean;
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

async function signThresholdMessage(
  walletPubkey: string,
  messageBytes: Uint8Array,
): Promise<Uint8Array> {
  const dkg = loadDkgResult(walletPubkey);

  const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
  const hasAllKeys = availableKeyIds.length >= dkg.threshold;

  if (!hasAllKeys || dkg.isMultiDevice) {
    throw new Error(
      "Multi-device signing for this transaction type is not yet supported. " +
        "Use a single-device vault or sign from the device that has all key packages."
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

export async function signSerializedTransaction(
  serializedTransactionBase64: string,
  walletPubkey: string,
  kind: SerializedTransactionKind,
): Promise<{ signedTransactionBase64: string; kind: SerializedTransactionKind }> {
  const fromPubkey = new PublicKey(walletPubkey);
  const rawBytes = Buffer.from(serializedTransactionBase64, "base64");

  if (kind === "versioned") {
    const transaction = VersionedTransaction.deserialize(rawBytes);
    const signatureBytes = await signThresholdMessage(
      walletPubkey,
      transaction.message.serialize(),
    );
    transaction.addSignature(fromPubkey, signatureBytes);
    return {
      signedTransactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
      kind,
    };
  }

  const transaction = Transaction.from(rawBytes);
  const signatureBytes = await signThresholdMessage(
    walletPubkey,
    transaction.serializeMessage(),
  );
  transaction.addSignature(fromPubkey, Buffer.from(signatureBytes));
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

/**
 * Sign a pre-built Transaction with the vault's FROST threshold key,
 * then submit it to the network.
 *
 * Only supports the local (single-device) signing path for now.
 * Multi-device signing must go through the SigningOrchestrator in SendView.
 */
export async function signAndSendTransaction(
  connection: Connection,
  tx: Transaction,
  walletPubkey: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const fromPubkey = new PublicKey(walletPubkey);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;

  onProgress?.("Signing with FROST threshold key...");

  const messageBytes = tx.serializeMessage();
  const signatureBytes = await signThresholdMessage(walletPubkey, messageBytes);

  onProgress?.("Submitting to Solana...");
  tx.addSignature(fromPubkey, Buffer.from(signatureBytes));

  const rawTx = tx.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  return signature;
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

  onProgress?.("Signing swap transaction...");
  const signatureBytes = await signThresholdMessage(
    walletPubkey,
    transaction.message.serialize(),
  );

  transaction.addSignature(fromPubkey, signatureBytes);

  onProgress?.("Submitting to Solana...");
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  return signature;
}
