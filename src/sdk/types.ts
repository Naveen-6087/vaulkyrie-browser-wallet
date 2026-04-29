import type { PublicKey } from "@solana/web3.js";
import type {
  OrchestrationStatus,
  RecoveryStatus,
  VaultStatus,
} from "./constants";

export interface VaultRegistryAccount {
  walletPubkey: PublicKey;
  currentAuthorityHash: Uint8Array;
  status: VaultStatus;
  bump: number;
  reserved: Uint8Array;
}

export interface QuantumAuthorityAccount {
  currentAuthorityHash: Uint8Array;
  currentAuthorityRoot: Uint8Array;
  lastConsumedDigest: Uint8Array;
  nextSequence: bigint;
  nextLeafIndex: number;
  bump: number;
}

export interface PqcWalletAccount {
  walletId: Uint8Array;
  currentRoot: Uint8Array;
  sequence: bigint;
  bump: number;
}

export interface AuthorityProofAccount {
  statementDigest: Uint8Array;
  proofCommitment: Uint8Array;
  bytesWritten: number;
  consumed: boolean;
  proofBytes: Uint8Array;
}

export interface SpendOrchestrationAccount {
  actionHash: Uint8Array;
  sessionCommitment: Uint8Array;
  signersCommitment: Uint8Array;
  signingPackageHash: Uint8Array;
  txBinding: Uint8Array;
  expirySlot: bigint;
  threshold: number;
  participantCount: number;
  status: OrchestrationStatus;
  bump: number;
}

export interface RecoveryStateAccount {
  vaultPubkey: PublicKey;
  recoveryCommitment: Uint8Array;
  newGroupKey: Uint8Array;
  newAuthorityHash: Uint8Array;
  expirySlot: bigint;
  newThreshold: number;
  newParticipantCount: number;
  status: RecoveryStatus;
  bump: number;
}

export interface InitVaultParams {
  walletPubkey: PublicKey;
  authorityHash: Uint8Array;
  bump: number;
}

export interface InitAuthorityParams {
  currentAuthorityHash: Uint8Array;
  currentAuthorityRoot: Uint8Array;
  bump: number;
}

export interface InitPqcWalletParams {
  walletId: Uint8Array;
  currentRoot: Uint8Array;
  bump: number;
}

export interface AdvancePqcWalletParams {
  signature: Uint8Array;
  nextRoot: Uint8Array;
  amount: bigint;
}

export interface SetVaultStatusParams {
  status: VaultStatus;
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
