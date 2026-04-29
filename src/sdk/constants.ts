import { PublicKey } from "@solana/web3.js";

export const VAULKYRIE_CORE_PROGRAM_ID = new PublicKey(
  "HUf5TWL4H18qJigd9m7h6MihX1xnzr2BVbbyGYFLEGPx",
);

export const Instruction = {
  Ping: 0,
  InitVault: 1,
  InitAuthority: 2,
  InitQuantumVault: 3,
  SetVaultStatus: 10,
  RotateAuthority: 11,
  InitAuthorityProof: 12,
  WriteAuthorityProofChunk: 13,
  RotateAuthorityStaged: 14,
  SplitQuantumVault: 15,
  CloseQuantumVault: 16,
  InitSpendOrchestration: 17,
  CommitSpendOrchestration: 18,
  CompleteSpendOrchestration: 19,
  FailSpendOrchestration: 20,
  InitRecovery: 22,
  CompleteRecovery: 23,
  MigrateAuthority: 24,
  AdvanceWinterAuthority: 26,
  InitPqcWallet: 27,
  AdvancePqcWallet: 28,
} as const;

export const DISCRIMINATOR = {
  VaultRegistry: new Uint8Array([86, 65, 85, 76, 75, 89, 82, 49]),
  QuantumAuthority: new Uint8Array([81, 83, 84, 65, 84, 69, 48, 49]),
  PqcWallet: new Uint8Array([80, 81, 67, 87, 65, 76, 84, 49]),
  AuthorityProof: new Uint8Array([65, 85, 84, 72, 80, 82, 70, 49]),
  SpendOrchestration: new Uint8Array([83, 80, 78, 68, 79, 82, 67, 49]),
  Recovery: new Uint8Array([82, 69, 67, 79, 86, 48, 48, 49]),
} as const;

export const ACCOUNT_SIZE = {
  VaultRegistry: 128,
  QuantumAuthorityState: 128,
  PqcWalletState: 88,
  AuthorityProofState: 1364,
  SpendOrchestrationState: 184,
  RecoveryState: 152,
} as const;

export const VaultStatus = {
  Active: 1,
  Recovery: 2,
  Locked: 3,
} as const;
export type VaultStatus = (typeof VaultStatus)[keyof typeof VaultStatus];

export const OrchestrationStatus = {
  Pending: 1,
  Committed: 2,
  Complete: 3,
  Failed: 4,
} as const;
export type OrchestrationStatus =
  (typeof OrchestrationStatus)[keyof typeof OrchestrationStatus];

export const RecoveryStatus = {
  Pending: 1,
  Complete: 2,
} as const;
export type RecoveryStatus =
  (typeof RecoveryStatus)[keyof typeof RecoveryStatus];

export const ActionKind = {
  Spend: 0,
  Rekey: 2,
  Close: 3,
} as const;
export type ActionKind = (typeof ActionKind)[keyof typeof ActionKind];

export const SEED = {
  VaultRegistry: "vault_registry",
  QuantumAuthority: "quantum_authority",
  AuthorityProof: "authority_proof",
  PqcWallet: "pqc_wallet",
  SpendOrchestration: "spend_orch",
} as const;

export const AUTHORITY_PROOF_CHUNK_MAX = 256;
