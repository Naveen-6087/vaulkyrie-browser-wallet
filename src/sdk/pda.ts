import { PublicKey } from "@solana/web3.js";
import { VAULKYRIE_CORE_PROGRAM_ID, SEED } from "./constants";

/**
 * Derive the vault registry PDA for a given wallet.
 * Seeds: ["vault_registry", wallet_pubkey]
 */
export function findVaultRegistryPda(
  walletPubkey: PublicKey,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.VaultRegistry), walletPubkey.toBuffer()],
    programId
  );
}

/**
 * Derive the policy receipt PDA.
 * Seeds: ["policy_receipt", vault_id, action_hash]
 */
export function findPolicyReceiptPda(
  vaultId: PublicKey,
  actionHash: Uint8Array,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED.PolicyReceipt),
      vaultId.toBuffer(),
      Buffer.from(actionHash),
    ],
    programId
  );
}

/**
 * Derive the action session PDA.
 * Seeds: ["action_session", vault_id, action_hash]
 */
export function findActionSessionPda(
  vaultId: PublicKey,
  actionHash: Uint8Array,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED.ActionSession),
      vaultId.toBuffer(),
      Buffer.from(actionHash),
    ],
    programId
  );
}

/**
 * Derive the quantum authority PDA.
 * Seeds: ["quantum_authority", vault_id]
 */
export function findQuantumAuthorityPda(
  vaultId: PublicKey,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.QuantumAuthority), vaultId.toBuffer()],
    programId
  );
}

/**
 * Derive the authority proof PDA.
 * Seeds: ["authority_proof", vault_id, statement_digest]
 */
export function findAuthorityProofPda(
  vaultId: PublicKey,
  statementDigest: Uint8Array,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED.AuthorityProof),
      vaultId.toBuffer(),
      Buffer.from(statementDigest),
    ],
    programId
  );
}

/**
 * Derive the quantum vault PDA.
 * Seeds: ["quantum_vault", hash]
 */
export function findQuantumVaultPda(
  hash: Uint8Array,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.QuantumVault), Buffer.from(hash)],
    programId
  );
}

/**
 * Derive the spend orchestration PDA.
 * Seeds: ["spend_orch", vault_id, action_hash]
 */
export function findSpendOrchestrationPda(
  vaultId: PublicKey,
  actionHash: Uint8Array,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED.SpendOrchestration),
      vaultId.toBuffer(),
      Buffer.from(actionHash),
    ],
    programId
  );
}
