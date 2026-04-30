import type { IUmbraSigner, SignableTransaction } from "@umbra-privacy/sdk/interfaces";
import type { SignedTransaction } from "@umbra-privacy/sdk/types";
import { signatureBytes, type SignatureBytes } from "@solana/kit";
import { signThresholdMessageWithCosigner } from "@/services/frost/cosignerThresholdSigner";

export function createVaulkyrieUmbraSigner(walletPublicKey: string): IUmbraSigner {
  return {
    address: walletPublicKey as IUmbraSigner["address"],
    async signTransaction(transaction) {
      return signUmbraTransaction(walletPublicKey, transaction);
    },
    async signTransactions(transactions) {
      return Promise.all(transactions.map((transaction) => signUmbraTransaction(walletPublicKey, transaction)));
    },
    async signMessage(message) {
      const signature = signatureBytes(await signThresholdMessageWithCosigner(walletPublicKey, toMutableBytes(message)));
      return {
        message,
        signature,
        signer: walletPublicKey as IUmbraSigner["address"],
      };
    },
  };
}

async function signUmbraTransaction(
  walletPublicKey: string,
  transaction: SignableTransaction,
): Promise<SignedTransaction> {
  const messageBytes = transaction.messageBytes;
  if (!messageBytes) {
    throw new Error("Umbra transaction is missing serialized message bytes.");
  }

  const signature = signatureBytes(await signThresholdMessageWithCosigner(walletPublicKey, toMutableBytes(messageBytes)));
  return {
    ...transaction,
    signatures: {
      ...transaction.signatures,
      [walletPublicKey]: signature as SignatureBytes,
    },
  } as SignedTransaction;
}

function toMutableBytes(bytes: ArrayLike<number>): Uint8Array {
  return Uint8Array.from(bytes);
}
