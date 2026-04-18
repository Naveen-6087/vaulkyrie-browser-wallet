/**
 * Vaulkyrie Policy MXE — instruction builders for the non-Arcium instructions.
 *
 * These builders target the Anchor-based policy bridge program. The four
 * "local" instructions (init_config, open_eval, finalize, abort) do NOT
 * require the Arcium MXE cluster and can be executed from a browser wallet
 * on devnet without any circuit or MPC dependency.
 *
 * Anchor instruction discriminators are the first 8 bytes of
 * SHA-256("global:<instruction_name>").
 */

import {
  PublicKey,
  TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { VAULKYRIE_POLICY_MXE_PROGRAM_ID } from "./constants";

// ── Anchor discriminators (pre-computed SHA-256 of "global:<fn>") ─────

const DISC = {
  initPolicyConfig: new Uint8Array([
    0x52, 0x78, 0x94, 0xe7, 0xfd, 0x66, 0x38, 0xcf,
  ]),
  openPolicyEvaluation: new Uint8Array([
    0xe7, 0x41, 0x83, 0x94, 0xa1, 0x69, 0x82, 0xf5,
  ]),
  finalizePolicyEvaluation: new Uint8Array([
    0x0d, 0xfb, 0xcd, 0x8f, 0x7e, 0xeb, 0x65, 0x73,
  ]),
  abortPolicyEvaluation: new Uint8Array([
    0xbb, 0xb5, 0xe1, 0x9f, 0x85, 0xa2, 0xc7, 0xa1,
  ]),
  queueArciumComputation: new Uint8Array([
    0xeb, 0xc7, 0xed, 0x6c, 0xab, 0x79, 0xd9, 0x20,
  ]),
} as const;

// ── Encoding helpers ─────────────────────────────────────────────────

function writeU8(buf: Uint8Array, offset: number, val: number): number {
  buf[offset] = val & 0xff;
  return offset + 1;
}

function writeU16LE(buf: Uint8Array, offset: number, val: number): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint16(offset, val, true);
  return offset + 2;
}

function writeU64LE(buf: Uint8Array, offset: number, val: bigint): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(offset, val, true);
  return offset + 8;
}

function writeBytes(buf: Uint8Array, offset: number, src: Uint8Array): number {
  buf.set(src, offset);
  return offset + src.length;
}

// ── Instruction builders ─────────────────────────────────────────────

export interface InitPolicyConfigParams {
  coreProgram: Uint8Array;       // 32 bytes
  arciumProgram: Uint8Array;     // 32 bytes
  mxeAccount: Uint8Array;        // 32 bytes
  policyVersion: bigint;
  bump: number;
}

/**
 * Initialize the policy configuration PDA.
 *
 * Accounts: [config (writable), authority (signer)]
 */
export function createInitPolicyConfigInstruction(
  config: PublicKey,
  authority: PublicKey,
  params: InitPolicyConfigParams,
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID,
): TransactionInstruction {
  // disc(8) + core_program(32) + arcium_program(32) + mxe_account(32) + policy_version(8) + bump(1)
  const data = new Uint8Array(8 + 32 + 32 + 32 + 8 + 1);
  let off = 0;
  off = writeBytes(data, off, DISC.initPolicyConfig);
  off = writeBytes(data, off, params.coreProgram);
  off = writeBytes(data, off, params.arciumProgram);
  off = writeBytes(data, off, params.mxeAccount);
  off = writeU64LE(data, off, params.policyVersion);
  writeU8(data, off, params.bump);

  return new TransactionInstruction({
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId,
    data: Buffer.from(data),
  });
}

export interface OpenPolicyEvaluationParams {
  vaultId: Uint8Array;                    // 32 bytes
  actionHash: Uint8Array;                 // 32 bytes
  encryptedInputCommitment: Uint8Array;   // 32 bytes
  requestNonce: bigint;
  expirySlot: bigint;
  computationOffset: bigint;
}

/**
 * Open a new policy evaluation request.
 *
 * Accounts: [config, evaluation (writable), authority (signer), clock]
 */
export function createOpenPolicyEvaluationInstruction(
  config: PublicKey,
  evaluation: PublicKey,
  authority: PublicKey,
  params: OpenPolicyEvaluationParams,
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID,
): TransactionInstruction {
  // disc(8) + vault_id(32) + action_hash(32) + encrypted_input(32) + nonce(8) + expiry(8) + offset(8)
  const data = new Uint8Array(8 + 32 + 32 + 32 + 8 + 8 + 8);
  let off = 0;
  off = writeBytes(data, off, DISC.openPolicyEvaluation);
  off = writeBytes(data, off, params.vaultId);
  off = writeBytes(data, off, params.actionHash);
  off = writeBytes(data, off, params.encryptedInputCommitment);
  off = writeU64LE(data, off, params.requestNonce);
  off = writeU64LE(data, off, params.expirySlot);
  writeU64LE(data, off, params.computationOffset);

  return new TransactionInstruction({
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: evaluation, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ],
    programId,
    data: Buffer.from(data),
  });
}

export interface FinalizePolicyEvaluationParams {
  requestCommitment: Uint8Array;   // 32 bytes
  actionHash: Uint8Array;          // 32 bytes
  policyVersion: bigint;
  threshold: number;
  nonce: bigint;
  receiptExpirySlot: bigint;
  delayUntilSlot: bigint;
  reasonCode: number;
  computationOffset: bigint;
  resultCommitment: Uint8Array;    // 32 bytes
}

/**
 * Finalize an evaluation with a signed decision envelope.
 *
 * Accounts: [evaluation (writable), authority (signer), clock]
 */
export function createFinalizePolicyEvaluationInstruction(
  evaluation: PublicKey,
  authority: PublicKey,
  params: FinalizePolicyEvaluationParams,
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID,
): TransactionInstruction {
  // disc(8) + req_commit(32) + action_hash(32) + policy_ver(8) + threshold(1) + nonce(8)
  // + receipt_expiry(8) + delay_until(8) + reason_code(2) + comp_offset(8) + result_commit(32)
  const data = new Uint8Array(8 + 32 + 32 + 8 + 1 + 8 + 8 + 8 + 2 + 8 + 32);
  let off = 0;
  off = writeBytes(data, off, DISC.finalizePolicyEvaluation);
  off = writeBytes(data, off, params.requestCommitment);
  off = writeBytes(data, off, params.actionHash);
  off = writeU64LE(data, off, params.policyVersion);
  off = writeU8(data, off, params.threshold);
  off = writeU64LE(data, off, params.nonce);
  off = writeU64LE(data, off, params.receiptExpirySlot);
  off = writeU64LE(data, off, params.delayUntilSlot);
  off = writeU16LE(data, off, params.reasonCode);
  off = writeU64LE(data, off, params.computationOffset);
  writeBytes(data, off, params.resultCommitment);

  return new TransactionInstruction({
    keys: [
      { pubkey: evaluation, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ],
    programId,
    data: Buffer.from(data),
  });
}

/**
 * Abort a pending policy evaluation.
 *
 * Accounts: [evaluation (writable), authority (signer)]
 */
export function createAbortPolicyEvaluationInstruction(
  evaluation: PublicKey,
  authority: PublicKey,
  reasonCode: number,
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID,
): TransactionInstruction {
  const data = new Uint8Array(8 + 2);
  let off = 0;
  off = writeBytes(data, off, DISC.abortPolicyEvaluation);
  writeU16LE(data, off, reasonCode);

  return new TransactionInstruction({
    keys: [
      { pubkey: evaluation, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId,
    data: Buffer.from(data),
  });
}

/**
 * Queue an Arcium MXE computation for the evaluation (state transition only).
 *
 * Accounts: [evaluation (writable), authority (signer), clock]
 */
export function createQueueArciumComputationInstruction(
  evaluation: PublicKey,
  authority: PublicKey,
  computationOffset: bigint,
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID,
): TransactionInstruction {
  const data = new Uint8Array(8 + 8);
  let off = 0;
  off = writeBytes(data, off, DISC.queueArciumComputation);
  writeU64LE(data, off, computationOffset);

  return new TransactionInstruction({
    keys: [
      { pubkey: evaluation, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ],
    programId,
    data: Buffer.from(data),
  });
}
