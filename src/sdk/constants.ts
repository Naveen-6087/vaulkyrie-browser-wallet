import { PublicKey } from "@solana/web3.js";

// ── Program IDs ──────────────────────────────────────────────────────
export const VAULKYRIE_CORE_PROGRAM_ID = new PublicKey(
  "HUf5TWL4H18qJigd9m7h6MihX1xnzr2BVbbyGYFLEGPx"
);

export const VAULKYRIE_POLICY_MXE_PROGRAM_ID = new PublicKey(
  "85DVk7pAZKxJGcqfN9WARt8HYPT89tjpgiQkdnca14sc"
);

// ── Instruction discriminators (single u8) ───────────────────────────
export const Instruction = {
  Ping: 0,
  InitVault: 1,
  InitAuthority: 2,
  InitQuantumVault: 3,
  StageReceipt: 4,
  ConsumeReceipt: 5,
  OpenSession: 6,
  ActivateSession: 7,
  ConsumeSession: 8,
  FinalizeSession: 9,
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
  StageBridgedReceipt: 21,
  InitRecovery: 22,
  CompleteRecovery: 23,
  MigrateAuthority: 24,
  AdvancePolicyVersion: 25,
  AdvanceWinterAuthority: 26,
  InitPqcWallet: 27,
  AdvancePqcWallet: 28,
} as const;

// ── Account discriminators (8-byte ASCII) ────────────────────────────
export const DISCRIMINATOR = {
  VaultRegistry: new Uint8Array([86, 65, 85, 76, 75, 89, 82, 49]), // "VAULKYR1"
  PolicyReceipt: new Uint8Array([80, 79, 76, 82, 67, 80, 84, 49]), // "POLRCPT1"
  ActionSession: new Uint8Array([83, 69, 83, 83, 73, 79, 78, 49]), // "SESSION1"
  QuantumAuthority: new Uint8Array([81, 83, 84, 65, 84, 69, 48, 49]), // "QSTATE01"
  PqcWallet: new Uint8Array([80, 81, 67, 87, 65, 76, 84, 49]), // "PQCWALT1"
  AuthorityProof: new Uint8Array([65, 85, 84, 72, 80, 82, 70, 49]), // "AUTHPRF1"
  SpendOrchestration: new Uint8Array([83, 80, 78, 68, 79, 82, 67, 49]), // "SPNDORC1"
  Recovery: new Uint8Array([82, 69, 67, 79, 86, 48, 48, 49]), // "RECOV001"
  PolicyConfig: new Uint8Array([80, 79, 76, 67, 70, 71, 48, 49]), // "POLCFG01"
  PolicyEvaluation: new Uint8Array([80, 79, 76, 69, 86, 65, 76, 49]), // "POLEVAL1"
} as const;

// ── Account sizes ────────────────────────────────────────────────────
export const ACCOUNT_SIZE = {
  VaultRegistry: 128,
  PolicyReceiptState: 96,
  ActionSessionState: 96,
  QuantumAuthorityState: 128,
  PqcWalletState: 88,
  AuthorityProofState: 1364, // 80 header + 1284 proof
  SpendOrchestrationState: 184,
  RecoveryState: 152,
  PolicyConfigState: 128,
  PolicyEvaluationState: 256,
} as const;

// ── Enums ────────────────────────────────────────────────────────────
export const VaultStatus = {
  Active: 1,
  Recovery: 2,
  Locked: 3,
} as const;
export type VaultStatus = (typeof VaultStatus)[keyof typeof VaultStatus];

export const SessionStatus = {
  Pending: 1,
  Ready: 2,
  Consumed: 3,
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

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

export const ThresholdRequirement = {
  OneOfThree: 1,
  TwoOfThree: 2,
  ThreeOfThree: 3,
  RequirePqcAuth: 255,
} as const;
export type ThresholdRequirement =
  (typeof ThresholdRequirement)[keyof typeof ThresholdRequirement];

export const ActionKind = {
  Spend: 0,
  PolicyUpdate: 1,
  Rekey: 2,
  Close: 3,
} as const;
export type ActionKind = (typeof ActionKind)[keyof typeof ActionKind];

export const PolicyEvaluationStatus = {
  Pending: 1,
  Finalized: 2,
  Aborted: 3,
  ComputationQueued: 4,
} as const;
export type PolicyEvaluationStatus =
  (typeof PolicyEvaluationStatus)[keyof typeof PolicyEvaluationStatus];

// ── PDA seeds ────────────────────────────────────────────────────────
export const SEED = {
  VaultRegistry: "vault_registry",
  PolicyReceipt: "policy_receipt",
  ActionSession: "action_session",
  QuantumAuthority: "quantum_authority",
  AuthorityProof: "authority_proof",
  QuantumVault: "quantum_vault",
  PqcWallet: "pqc_wallet",
  SpendOrchestration: "spend_orch",
  PolicyConfig: "policy_config",
  PolicyEvaluation: "policy_eval",
} as const;

// ── Crypto constants ─────────────────────────────────────────────────
export const WOTS_CHAIN_COUNT = 16;
export const WOTS_ELEMENT_BYTES = 32;
export const WOTS_KEY_BYTES = 512; // 16 * 32
export const XMSS_TREE_HEIGHT = 8;
export const XMSS_AUTH_PATH_BYTES = 256; // 8 * 32
export const XMSS_LEAF_COUNT = 256; // 2^8
export const WOTS_AUTH_PROOF_LEN = 1284; // 512*2 + 4 + 256
export const WINTER_AUTHORITY_MESSAGE_SCALARS = 22;
export const WINTER_AUTHORITY_TOTAL_SCALARS = 24;
export const WINTER_AUTHORITY_SIGNATURE_BYTES = 768; // 24 * 32
export const WINTERNITZ_SIG_BYTES = 1417;
export const AUTHORITY_PROOF_CHUNK_MAX = 256;
