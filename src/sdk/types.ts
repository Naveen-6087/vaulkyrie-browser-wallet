import type { PublicKey } from "@solana/web3.js";
import type {
  VaultStatus,
  SessionStatus,
  OrchestrationStatus,
  RecoveryStatus,
  ThresholdRequirement,
  PolicyEvaluationStatus,
} from "./constants";

// ── Wire-format types (match Rust encoding exactly) ──────────────────

export interface PolicyReceipt {
  actionHash: Uint8Array; // 32 bytes
  policyVersion: bigint; // u64
  threshold: ThresholdRequirement; // u8
  nonce: bigint; // u64
  expirySlot: bigint; // u64
}

export interface AuthorityRotationStatement {
  actionHash: Uint8Array; // 32 bytes
  nextAuthorityHash: Uint8Array; // 32 bytes
  sequence: bigint; // u64
  expirySlot: bigint; // u64
}

export interface WotsAuthProof {
  publicKey: Uint8Array; // 512 bytes
  signature: Uint8Array; // 512 bytes
  leafIndex: number; // u32
  authPath: Uint8Array; // 256 bytes
}

// ── On-chain account state types ─────────────────────────────────────

export interface VaultRegistryAccount {
  walletPubkey: PublicKey;
  currentAuthorityHash: Uint8Array; // 32 bytes
  policyVersion: bigint;
  lastConsumedReceiptNonce: bigint;
  status: VaultStatus;
  bump: number;
  policyMxeProgram: PublicKey;
}

export interface PolicyReceiptStateAccount {
  receiptCommitment: Uint8Array; // 32 bytes
  actionHash: Uint8Array; // 32 bytes
  nonce: bigint;
  expirySlot: bigint;
  consumed: boolean;
}

export interface ActionSessionStateAccount {
  receiptCommitment: Uint8Array; // 32 bytes
  actionHash: Uint8Array; // 32 bytes
  policyVersion: bigint;
  expirySlot: bigint;
  threshold: number;
  status: SessionStatus;
}

export interface QuantumAuthorityAccount {
  currentAuthorityHash: Uint8Array; // 32 bytes
  currentAuthorityRoot: Uint8Array; // 32 bytes
  lastConsumedDigest: Uint8Array; // 32 bytes
  nextSequence: bigint;
  nextLeafIndex: number; // u32
  bump: number;
}

export interface AuthorityProofAccount {
  statementDigest: Uint8Array; // 32 bytes
  proofCommitment: Uint8Array; // 32 bytes
  bytesWritten: number; // u32
  consumed: boolean;
  proofBytes: Uint8Array; // variable, up to 1284 bytes
}

export interface SpendOrchestrationAccount {
  actionHash: Uint8Array; // 32 bytes
  sessionCommitment: Uint8Array; // 32 bytes
  signersCommitment: Uint8Array; // 32 bytes
  signingPackageHash: Uint8Array; // 32 bytes
  txBinding: Uint8Array; // 32 bytes
  expirySlot: bigint;
  threshold: number;
  participantCount: number;
  status: OrchestrationStatus;
  bump: number;
}

export interface RecoveryStateAccount {
  vaultPubkey: PublicKey;
  recoveryCommitment: Uint8Array; // 32 bytes
  newGroupKey: Uint8Array; // 32 bytes
  newAuthorityHash: Uint8Array; // 32 bytes
  expirySlot: bigint;
  newThreshold: number;
  newParticipantCount: number;
  status: RecoveryStatus;
  bump: number;
}

export interface PolicyConfigAccount {
  coreProgram: PublicKey;
  arciumProgram: PublicKey;
  mxeAccount: PublicKey;
  policyVersion: bigint;
  nextRequestNonce: bigint;
  bump: number;
}

export interface PolicyEvaluationAccount {
  requestCommitment: Uint8Array; // 32 bytes
  vaultId: Uint8Array; // 32 bytes
  actionHash: Uint8Array; // 32 bytes
  encryptedInputCommitment: Uint8Array; // 32 bytes
  policyVersion: bigint;
  requestNonce: bigint;
  expirySlot: bigint;
  computationOffset: bigint;
  receiptCommitment: Uint8Array; // 32 bytes
  decisionCommitment: Uint8Array; // 32 bytes
  delayUntilSlot: bigint;
  status: PolicyEvaluationStatus;
  reasonCode: number;
}

// ── Instruction parameter types ──────────────────────────────────────

export interface InitVaultParams {
  walletPubkey: PublicKey;
  authorityHash: Uint8Array;
  policyVersion: bigint;
  bump: number;
  policyMxeProgram: PublicKey;
}

export interface InitAuthorityParams {
  currentAuthorityHash: Uint8Array;
  currentAuthorityRoot: Uint8Array;
  bump: number;
}

export interface InitQuantumVaultParams {
  hash: Uint8Array;
  bump: number;
}

export interface StageReceiptParams {
  receipt: PolicyReceipt;
}

export interface OpenSessionParams {
  receipt: PolicyReceipt;
}

export interface ActivateSessionParams {
  actionHash: Uint8Array;
}

export interface SetVaultStatusParams {
  status: VaultStatus;
}

export interface RotateAuthorityParams {
  statement: AuthorityRotationStatement;
  proof: WotsAuthProof;
}

export interface InitAuthorityProofParams {
  statementDigest: Uint8Array;
  proofCommitment: Uint8Array;
}

export interface WriteAuthorityProofChunkParams {
  offset: number;
  chunk: Uint8Array;
}

export interface RotateAuthorityStagedParams {
  statement: AuthorityRotationStatement;
}

export interface SplitQuantumVaultParams {
  signature: Uint8Array; // 1417 bytes
  amount: bigint;
  bump: number;
}

export interface CloseQuantumVaultParams {
  signature: Uint8Array; // 1417 bytes
  bump: number;
}

export interface InitSpendOrchestrationParams {
  actionHash: Uint8Array;
  sessionCommitment: Uint8Array;
  signersCommitment: Uint8Array;
  signingPackageHash: Uint8Array;
  expirySlot: bigint;
  threshold: number;
  participantCount: number;
  bump: number;
}

export interface CommitSpendOrchestrationParams {
  actionHash: Uint8Array;
  signingPackageHash: Uint8Array;
}

export interface CompleteSpendOrchestrationParams {
  actionHash: Uint8Array;
  txBinding: Uint8Array;
}

export interface FailSpendOrchestrationParams {
  actionHash: Uint8Array;
  reasonCode: number;
}

export interface StageBridgedReceiptParams {
  receipt: PolicyReceipt;
}

export interface InitRecoveryParams {
  vaultPubkey: PublicKey;
  recoveryCommitment: Uint8Array;
  expirySlot: bigint;
  newThreshold: number;
  newParticipantCount: number;
  bump: number;
}

export interface CompleteRecoveryParams {
  newGroupKey: Uint8Array;
  newAuthorityHash: Uint8Array;
}

export interface MigrateAuthorityParams {
  newAuthorityRoot: Uint8Array;
}

export interface AdvancePolicyVersionParams {
  newVersion: bigint;
}
