/**
 * SPL Token transfer helpers.
 * Builds token transfer instructions for the FROST threshold signer.
 */
import {
  PublicKey,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/**
 * Build a transaction that transfers SPL tokens from `sender` to `recipient`.
 * Creates the recipient's ATA if it doesn't exist yet.
 */
export async function buildSplTransferTransaction(
  connection: Connection,
  sender: PublicKey,
  recipient: PublicKey,
  mint: PublicKey,
  amount: number,
  decimals: number,
): Promise<Transaction> {
  const senderAta = getAssociatedTokenAddressSync(mint, sender);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);

  const tx = new Transaction();

  // Create recipient ATA if it doesn't exist
  const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
  if (!recipientAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        sender, // payer
        recipientAta,
        recipient,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  // Raw amount = human amount × 10^decimals
  const rawAmount = BigInt(Math.round(amount * 10 ** decimals));

  tx.add(
    createTransferInstruction(
      senderAta,
      recipientAta,
      sender, // owner/authority
      rawAmount,
    ),
  );

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = sender;

  return tx;
}
