import { PublicKey } from "@solana/web3.js";
import { SEED, VAULKYRIE_CORE_PROGRAM_ID } from "./constants";

export function findVaultRegistryPda(
  walletPubkey: PublicKey,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.VaultRegistry), walletPubkey.toBuffer()],
    programId,
  );
}

export function findQuantumAuthorityPda(
  vaultId: PublicKey,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.QuantumAuthority), vaultId.toBuffer()],
    programId,
  );
}

export function findPqcWalletPda(
  walletId: Uint8Array,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.PqcWallet), Buffer.from(walletId)],
    programId,
  );
}

export function findSpendOrchestrationPda(
  vaultId: PublicKey,
  actionHash: Uint8Array,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.SpendOrchestration), vaultId.toBuffer(), Buffer.from(actionHash)],
    programId,
  );
}
