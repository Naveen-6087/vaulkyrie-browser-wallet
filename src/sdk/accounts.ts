import { PublicKey } from "@solana/web3.js";
import { DISCRIMINATOR, ACCOUNT_SIZE } from "./constants";
import type { VaultStatus, SessionStatus, OrchestrationStatus, RecoveryStatus } from "./constants";
import type {
  VaultRegistryAccount,
  PolicyReceiptStateAccount,
  ActionSessionStateAccount,
  QuantumAuthorityAccount,
  AuthorityProofAccount,
  SpendOrchestrationAccount,
  RecoveryStateAccount,
  PolicyConfigAccount,
} from "./types";

// ── Helpers ──────────────────────────────────────────────────────────

function readU8(buf: Uint8Array, offset: number): number {
  return buf[offset];
}

function readU32LE(buf: Uint8Array, offset: number): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return dv.getUint32(offset, true);
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return dv.getBigUint64(offset, true);
}

function readBytes(buf: Uint8Array, offset: number, len: number): Uint8Array {
  return buf.slice(offset, offset + len);
}

function readPubkey(buf: Uint8Array, offset: number): PublicKey {
  return new PublicKey(buf.slice(offset, offset + 32));
}

function matchDiscriminator(
  data: Uint8Array,
  expected: Uint8Array
): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== expected[i]) return false;
  }
  return true;
}

// ── Decoders ─────────────────────────────────────────────────────────

export function decodeVaultRegistry(
  data: Uint8Array
): VaultRegistryAccount {
  if (data.length < ACCOUNT_SIZE.VaultRegistry) {
    throw new Error(
      `VaultRegistry: expected ${ACCOUNT_SIZE.VaultRegistry} bytes, got ${data.length}`
    );
  }
  if (!matchDiscriminator(data, DISCRIMINATOR.VaultRegistry)) {
    throw new Error("VaultRegistry: invalid discriminator");
  }
  return {
    walletPubkey: readPubkey(data, 8),
    currentAuthorityHash: readBytes(data, 40, 32),
    policyVersion: readU64LE(data, 72),
    lastConsumedReceiptNonce: readU64LE(data, 80),
    status: readU8(data, 88) as VaultStatus,
    bump: readU8(data, 89),
    policyMxeProgram: readPubkey(data, 90),
  };
}

export function decodePolicyReceiptState(
  data: Uint8Array
): PolicyReceiptStateAccount {
  if (data.length < ACCOUNT_SIZE.PolicyReceiptState) {
    throw new Error(
      `PolicyReceiptState: expected ${ACCOUNT_SIZE.PolicyReceiptState} bytes, got ${data.length}`
    );
  }
  if (!matchDiscriminator(data, DISCRIMINATOR.PolicyReceipt)) {
    throw new Error("PolicyReceiptState: invalid discriminator");
  }
  return {
    receiptCommitment: readBytes(data, 8, 32),
    actionHash: readBytes(data, 40, 32),
    nonce: readU64LE(data, 72),
    expirySlot: readU64LE(data, 80),
    consumed: readU8(data, 88) !== 0,
  };
}

export function decodeActionSessionState(
  data: Uint8Array
): ActionSessionStateAccount {
  if (data.length < ACCOUNT_SIZE.ActionSessionState) {
    throw new Error(
      `ActionSessionState: expected ${ACCOUNT_SIZE.ActionSessionState} bytes, got ${data.length}`
    );
  }
  if (!matchDiscriminator(data, DISCRIMINATOR.ActionSession)) {
    throw new Error("ActionSessionState: invalid discriminator");
  }
  return {
    receiptCommitment: readBytes(data, 8, 32),
    actionHash: readBytes(data, 40, 32),
    policyVersion: readU64LE(data, 72),
    expirySlot: readU64LE(data, 80),
    threshold: readU8(data, 88),
    status: readU8(data, 89) as SessionStatus,
  };
}

export function decodeQuantumAuthority(
  data: Uint8Array
): QuantumAuthorityAccount {
  if (data.length < ACCOUNT_SIZE.QuantumAuthorityState) {
    throw new Error(
      `QuantumAuthority: expected ${ACCOUNT_SIZE.QuantumAuthorityState} bytes, got ${data.length}`
    );
  }
  if (!matchDiscriminator(data, DISCRIMINATOR.QuantumAuthority)) {
    throw new Error("QuantumAuthority: invalid discriminator");
  }
  return {
    currentAuthorityHash: readBytes(data, 8, 32),
    currentAuthorityRoot: readBytes(data, 40, 32),
    lastConsumedDigest: readBytes(data, 72, 32),
    nextSequence: readU64LE(data, 104),
    nextLeafIndex: readU32LE(data, 112),
    bump: readU8(data, 116),
  };
}

export function decodeAuthorityProof(
  data: Uint8Array
): AuthorityProofAccount {
  if (data.length < 80) {
    throw new Error(
      `AuthorityProof: expected at least 80 bytes, got ${data.length}`
    );
  }
  if (!matchDiscriminator(data, DISCRIMINATOR.AuthorityProof)) {
    throw new Error("AuthorityProof: invalid discriminator");
  }
  const bytesWritten = readU32LE(data, 72);
  return {
    statementDigest: readBytes(data, 8, 32),
    proofCommitment: readBytes(data, 40, 32),
    bytesWritten,
    consumed: readU8(data, 76) !== 0,
    proofBytes: readBytes(data, 80, Math.min(bytesWritten, data.length - 80)),
  };
}

export function decodeSpendOrchestration(
  data: Uint8Array
): SpendOrchestrationAccount {
  if (data.length < ACCOUNT_SIZE.SpendOrchestrationState) {
    throw new Error(
      `SpendOrchestration: expected ${ACCOUNT_SIZE.SpendOrchestrationState} bytes, got ${data.length}`
    );
  }
  if (!matchDiscriminator(data, DISCRIMINATOR.SpendOrchestration)) {
    throw new Error("SpendOrchestration: invalid discriminator");
  }
  return {
    actionHash: readBytes(data, 8, 32),
    sessionCommitment: readBytes(data, 40, 32),
    signersCommitment: readBytes(data, 72, 32),
    signingPackageHash: readBytes(data, 104, 32),
    txBinding: readBytes(data, 136, 32),
    expirySlot: readU64LE(data, 168),
    threshold: readU8(data, 176),
    participantCount: readU8(data, 177),
    status: readU8(data, 178) as OrchestrationStatus,
    bump: readU8(data, 179),
  };
}

export function decodeRecoveryState(
  data: Uint8Array
): RecoveryStateAccount {
  if (data.length < ACCOUNT_SIZE.RecoveryState) {
    throw new Error(
      `RecoveryState: expected ${ACCOUNT_SIZE.RecoveryState} bytes, got ${data.length}`
    );
  }
  if (!matchDiscriminator(data, DISCRIMINATOR.Recovery)) {
    throw new Error("RecoveryState: invalid discriminator");
  }
  return {
    vaultPubkey: readPubkey(data, 8),
    recoveryCommitment: readBytes(data, 40, 32),
    newGroupKey: readBytes(data, 72, 32),
    newAuthorityHash: readBytes(data, 104, 32),
    expirySlot: readU64LE(data, 136),
    newThreshold: readU8(data, 144),
    newParticipantCount: readU8(data, 145),
    status: readU8(data, 146) as RecoveryStatus,
    bump: readU8(data, 147),
  };
}

export function decodePolicyConfig(
  data: Uint8Array
): PolicyConfigAccount {
  if (data.length < ACCOUNT_SIZE.PolicyConfigState) {
    throw new Error(
      `PolicyConfig: expected ${ACCOUNT_SIZE.PolicyConfigState} bytes, got ${data.length}`
    );
  }
  if (!matchDiscriminator(data, DISCRIMINATOR.PolicyConfig)) {
    throw new Error("PolicyConfig: invalid discriminator");
  }
  return {
    coreProgram: readPubkey(data, 8),
    arciumProgram: readPubkey(data, 40),
    mxeAccount: readPubkey(data, 72),
    policyVersion: readU64LE(data, 104),
    nextRequestNonce: readU64LE(data, 112),
    bump: readU8(data, 120),
  };
}
