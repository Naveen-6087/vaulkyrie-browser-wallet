/**
 * Shared utility for FROST-signing a Solana Transaction.
 *
 * Encapsulates the single-device (local) signing path used across
 * SendView, PolicyView, and any future view that submits transactions
 * from the vault's threshold key.
 */

import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
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

  if (!dkg) {
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
  const dkg = loadDkgResult(walletPubkey);

  const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
  const hasAllKeys = availableKeyIds.length >= dkg.threshold;

  if (!hasAllKeys || dkg.isMultiDevice) {
    throw new Error(
      "Multi-device signing for policy transactions is not yet supported. " +
        "Use a single-device vault or sign from the device that has all key packages."
    );
  }

  const fromPubkey = new PublicKey(walletPubkey);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;

  onProgress?.("Signing with FROST threshold key...");

  const messageBytes = tx.serializeMessage();
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

  onProgress?.("Submitting to Solana...");

  const sigBytes = hexToBytes(result.signatureHex);
  tx.addSignature(fromPubkey, Buffer.from(sigBytes));

  const rawTx = tx.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  return signature;
}
