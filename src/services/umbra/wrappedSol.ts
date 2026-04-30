import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  prepareLegacyVaultTransaction,
  sendSignedLegacyVaultTransaction,
} from "@/services/frost/signTransaction";
import { signThresholdMessageWithCosigner } from "@/services/frost/cosignerThresholdSigner";

export async function wrapSolForVault(
  connection: Connection,
  walletPublicKey: string,
  lamports: bigint,
  onProgress?: (message: string) => void,
): Promise<string> {
  if (lamports <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }

  const owner = new PublicKey(walletPublicKey);
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, owner);
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: ata,
      lamports,
    }),
    createSyncNativeInstruction(ata),
  );

  onProgress?.("Preparing wrapped SOL account...");
  await prepareLegacyVaultTransaction(connection, transaction, walletPublicKey);
  const signatureBytes = await signThresholdMessageWithCosigner(
    walletPublicKey,
    transaction.serializeMessage(),
    onProgress,
  );

  return sendSignedLegacyVaultTransaction(connection, transaction, walletPublicKey, signatureBytes);
}

export async function unwrapAllSolForVault(
  connection: Connection,
  walletPublicKey: string,
  onProgress?: (message: string) => void,
): Promise<string> {
  const owner = new PublicKey(walletPublicKey);
  const ata = await getAssociatedTokenAddress(NATIVE_MINT, owner);
  const accountInfo = await connection.getAccountInfo(ata);
  if (!accountInfo) {
    throw new Error("No wrapped SOL token account found.");
  }

  const transaction = new Transaction().add(
    createCloseAccountInstruction(ata, owner, owner),
  );

  onProgress?.("Preparing wrapped SOL close transaction...");
  await prepareLegacyVaultTransaction(connection, transaction, walletPublicKey);
  const signatureBytes = await signThresholdMessageWithCosigner(
    walletPublicKey,
    transaction.serializeMessage(),
    onProgress,
  );

  transaction.addSignature(owner, Buffer.from(signatureBytes));
  const rawTx = transaction.serialize();
  return connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
}
