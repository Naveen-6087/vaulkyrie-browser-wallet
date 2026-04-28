import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { Instruction, VAULKYRIE_CORE_PROGRAM_ID } from "./constants";
import type {
  PolicyReceipt,
  AuthorityRotationStatement,
  WinterAuthorityAdvanceStatement,
  WotsAuthProof,
  InitVaultParams,
  InitAuthorityParams,
  InitQuantumVaultParams,
  InitPqcWalletParams,
  StageReceiptParams,
  OpenSessionParams,
  ActivateSessionParams,
  SetVaultStatusParams,
  RotateAuthorityParams,
  InitAuthorityProofParams,
  WriteAuthorityProofChunkParams,
  RotateAuthorityStagedParams,
  AdvanceWinterAuthorityParams,
  SplitQuantumVaultParams,
  CloseQuantumVaultParams,
  AdvancePqcWalletParams,
  InitSpendOrchestrationParams,
  CommitSpendOrchestrationParams,
  CompleteSpendOrchestrationParams,
  FailSpendOrchestrationParams,
  StageBridgedReceiptParams,
  InitRecoveryParams,
  CompleteRecoveryParams,
  MigrateAuthorityParams,
  AdvancePolicyVersionParams,
} from "./types";

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

function writeU32LE(buf: Uint8Array, offset: number, val: number): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(offset, val, true);
  return offset + 4;
}

function writeU64LE(buf: Uint8Array, offset: number, val: bigint): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(offset, val, true);
  return offset + 8;
}

function writeBytes(
  buf: Uint8Array,
  offset: number,
  src: Uint8Array
): number {
  buf.set(src, offset);
  return offset + src.length;
}

function writePubkey(
  buf: Uint8Array,
  offset: number,
  key: PublicKey
): number {
  return writeBytes(buf, offset, key.toBytes());
}

function encodeReceipt(receipt: PolicyReceipt): Uint8Array {
  const buf = new Uint8Array(57);
  let off = 0;
  off = writeBytes(buf, off, receipt.actionHash);
  off = writeU64LE(buf, off, receipt.policyVersion);
  off = writeU8(buf, off, receipt.threshold);
  off = writeU64LE(buf, off, receipt.nonce);
  writeU64LE(buf, off, receipt.expirySlot);
  return buf;
}

function encodeStatement(stmt: AuthorityRotationStatement): Uint8Array {
  const buf = new Uint8Array(80);
  let off = 0;
  off = writeBytes(buf, off, stmt.actionHash);
  off = writeBytes(buf, off, stmt.nextAuthorityHash);
  off = writeU64LE(buf, off, stmt.sequence);
  writeU64LE(buf, off, stmt.expirySlot);
  return buf;
}

function encodeWinterAuthorityAdvanceStatement(
  stmt: WinterAuthorityAdvanceStatement
): Uint8Array {
  const buf = new Uint8Array(112);
  let off = 0;
  off = writeBytes(buf, off, stmt.actionHash);
  off = writeBytes(buf, off, stmt.currentRoot);
  off = writeBytes(buf, off, stmt.nextRoot);
  off = writeU64LE(buf, off, stmt.sequence);
  writeU64LE(buf, off, stmt.expirySlot);
  return buf;
}

function encodeWotsAuthProof(proof: WotsAuthProof): Uint8Array {
  const buf = new Uint8Array(1284);
  let off = 0;
  off = writeBytes(buf, off, proof.publicKey); // 512
  off = writeBytes(buf, off, proof.signature); // 512
  off = writeU32LE(buf, off, proof.leafIndex); // 4
  writeBytes(buf, off, proof.authPath); // 256
  return buf;
}

function makeIx(
  tag: (typeof Instruction)[keyof typeof Instruction],
  data: Uint8Array,
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const ixData = new Uint8Array(1 + data.length);
  ixData[0] = tag;
  ixData.set(data, 1);
  return new TransactionInstruction({
    keys,
    programId,
    data: Buffer.from(ixData),
  });
}

// ── Instruction builders ─────────────────────────────────────────────

export function createPingInstruction(
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  return makeIx(Instruction.Ping, new Uint8Array(0), [], programId);
}

export function createInitVaultInstruction(
  vaultRegistry: PublicKey,
  walletSigner: PublicKey,
  params: InitVaultParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(105);
  let off = 0;
  off = writePubkey(buf, off, params.walletPubkey);
  off = writeBytes(buf, off, params.authorityHash);
  off = writeU64LE(buf, off, params.policyVersion);
  off = writeU8(buf, off, params.bump);
  writePubkey(buf, off, params.policyMxeProgram);
  return makeIx(
    Instruction.InitVault,
    buf,
    [
      { pubkey: vaultRegistry, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId
  );
}

export function createInitAuthorityInstruction(
  authority: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: InitAuthorityParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(65);
  let off = 0;
  off = writeBytes(buf, off, params.currentAuthorityHash);
  off = writeBytes(buf, off, params.currentAuthorityRoot);
  writeU8(buf, off, params.bump);
  return makeIx(
    Instruction.InitAuthority,
    buf,
    [
      { pubkey: authority, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: walletSigner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId
  );
}

export function createInitQuantumVaultInstruction(
  payer: PublicKey,
  vault: PublicKey,
  params: InitQuantumVaultParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(33);
  let off = 0;
  off = writeBytes(buf, off, params.hash);
  writeU8(buf, off, params.bump);
  return makeIx(
    Instruction.InitQuantumVault,
    buf,
    [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId
  );
}

export function createStageReceiptInstruction(
  vault: PublicKey,
  receiptAccount: PublicKey,
  walletSigner: PublicKey,
  params: StageReceiptParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  return makeIx(
    Instruction.StageReceipt,
    encodeReceipt(params.receipt),
    [
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: receiptAccount, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createConsumeReceiptInstruction(
  vault: PublicKey,
  receiptAccount: PublicKey,
  walletSigner: PublicKey,
  params: StageReceiptParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  return makeIx(
    Instruction.ConsumeReceipt,
    encodeReceipt(params.receipt),
    [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: receiptAccount, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createOpenSessionInstruction(
  receiptAccount: PublicKey,
  sessionAccount: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: OpenSessionParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  return makeIx(
    Instruction.OpenSession,
    encodeReceipt(params.receipt),
    [
      { pubkey: receiptAccount, isSigner: false, isWritable: false },
      { pubkey: sessionAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createActivateSessionInstruction(
  session: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: ActivateSessionParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  return makeIx(
    Instruction.ActivateSession,
    params.actionHash,
    [
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createConsumeSessionInstruction(
  session: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  actionHash: Uint8Array,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  return makeIx(
    Instruction.ConsumeSession,
    actionHash,
    [
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createFinalizeSessionInstruction(
  receiptAccount: PublicKey,
  session: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  receipt: PolicyReceipt,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  return makeIx(
    Instruction.FinalizeSession,
    encodeReceipt(receipt),
    [
      { pubkey: receiptAccount, isSigner: false, isWritable: true },
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createSetVaultStatusInstruction(
  vault: PublicKey,
  walletSigner: PublicKey,
  params: SetVaultStatusParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(1);
  buf[0] = params.status;
  return makeIx(
    Instruction.SetVaultStatus,
    buf,
    [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createRotateAuthorityInstruction(
  vault: PublicKey,
  authority: PublicKey,
  walletSigner: PublicKey,
  params: RotateAuthorityParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const stmt = encodeStatement(params.statement);
  const proof = encodeWotsAuthProof(params.proof);
  const buf = new Uint8Array(stmt.length + proof.length);
  buf.set(stmt, 0);
  buf.set(proof, stmt.length);
  return makeIx(
    Instruction.RotateAuthority,
    buf,
    [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createInitAuthorityProofInstruction(
  proofAccount: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: InitAuthorityProofParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(64);
  let off = 0;
  off = writeBytes(buf, off, params.statementDigest);
  writeBytes(buf, off, params.proofCommitment);
  return makeIx(
    Instruction.InitAuthorityProof,
    buf,
    [
      { pubkey: proofAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createWriteAuthorityProofChunkInstruction(
  proofAccount: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: WriteAuthorityProofChunkParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(6 + params.chunk.length);
  let off = 0;
  off = writeU32LE(buf, off, params.offset);
  off = writeU16LE(buf, off, params.chunk.length);
  writeBytes(buf, off, params.chunk);
  return makeIx(
    Instruction.WriteAuthorityProofChunk,
    buf,
    [
      { pubkey: proofAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createRotateAuthorityStagedInstruction(
  vault: PublicKey,
  authority: PublicKey,
  proofAccount: PublicKey,
  walletSigner: PublicKey,
  params: RotateAuthorityStagedParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  return makeIx(
    Instruction.RotateAuthorityStaged,
    encodeStatement(params.statement),
    [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: true },
      { pubkey: proofAccount, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createInitPqcWalletInstruction(
  payer: PublicKey,
  wallet: PublicKey,
  params: InitPqcWalletParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(65);
  let off = 0;
  off = writeBytes(buf, off, params.walletId);
  off = writeBytes(buf, off, params.currentRoot);
  writeU8(buf, off, params.bump);
  return makeIx(
    Instruction.InitPqcWallet,
    buf,
    [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId
  );
}

export function createAdvanceWinterAuthorityInstruction(
  vault: PublicKey,
  authority: PublicKey,
  walletSigner: PublicKey,
  params: AdvanceWinterAuthorityParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const statement = encodeWinterAuthorityAdvanceStatement(params.statement);
  const buf = new Uint8Array(statement.length + params.signature.length);
  buf.set(statement, 0);
  buf.set(params.signature, statement.length);
  return makeIx(
    Instruction.AdvanceWinterAuthority,
    buf,
    [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createSplitQuantumVaultInstruction(
  vault: PublicKey,
  splitDest: PublicKey,
  refundDest: PublicKey,
  params: SplitQuantumVaultParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(params.signature.length + 8 + 1);
  let off = 0;
  off = writeBytes(buf, off, params.signature);
  off = writeU64LE(buf, off, params.amount);
  writeU8(buf, off, params.bump);
  return makeIx(
    Instruction.SplitQuantumVault,
    buf,
    [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: splitDest, isSigner: false, isWritable: true },
      { pubkey: refundDest, isSigner: false, isWritable: true },
    ],
    programId
  );
}

export function createCloseQuantumVaultInstruction(
  vault: PublicKey,
  refundDest: PublicKey,
  params: CloseQuantumVaultParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(params.signature.length + 1);
  let off = 0;
  off = writeBytes(buf, off, params.signature);
  writeU8(buf, off, params.bump);
  return makeIx(
    Instruction.CloseQuantumVault,
    buf,
    [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: refundDest, isSigner: false, isWritable: true },
    ],
    programId
  );
}

export function createAdvancePqcWalletInstruction(
  wallet: PublicKey,
  destination: PublicKey,
  params: AdvancePqcWalletParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(params.signature.length + 32 + 8);
  let off = 0;
  off = writeBytes(buf, off, params.signature);
  off = writeBytes(buf, off, params.nextRoot);
  writeU64LE(buf, off, params.amount);
  return makeIx(
    Instruction.AdvancePqcWallet,
    buf,
    [
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
    ],
    programId
  );
}

export function createInitSpendOrchestrationInstruction(
  orchAccount: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: InitSpendOrchestrationParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(139);
  let off = 0;
  off = writeBytes(buf, off, params.actionHash);
  off = writeBytes(buf, off, params.sessionCommitment);
  off = writeBytes(buf, off, params.signersCommitment);
  off = writeBytes(buf, off, params.signingPackageHash);
  off = writeU64LE(buf, off, params.expirySlot);
  off = writeU8(buf, off, params.threshold);
  off = writeU8(buf, off, params.participantCount);
  writeU8(buf, off, params.bump);
  return makeIx(
    Instruction.InitSpendOrchestration,
    buf,
    [
      { pubkey: orchAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: walletSigner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId
  );
}

export function createCommitSpendOrchestrationInstruction(
  orchAccount: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: CommitSpendOrchestrationParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(64);
  let off = 0;
  off = writeBytes(buf, off, params.actionHash);
  writeBytes(buf, off, params.signingPackageHash);
  return makeIx(
    Instruction.CommitSpendOrchestration,
    buf,
    [
      { pubkey: orchAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createCompleteSpendOrchestrationInstruction(
  orchAccount: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: CompleteSpendOrchestrationParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(64);
  let off = 0;
  off = writeBytes(buf, off, params.actionHash);
  writeBytes(buf, off, params.txBinding);
  return makeIx(
    Instruction.CompleteSpendOrchestration,
    buf,
    [
      { pubkey: orchAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createFailSpendOrchestrationInstruction(
  orchAccount: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: FailSpendOrchestrationParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(33);
  let off = 0;
  off = writeBytes(buf, off, params.actionHash);
  writeU8(buf, off, params.reasonCode);
  return makeIx(
    Instruction.FailSpendOrchestration,
    buf,
    [
      { pubkey: orchAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId
  );
}

export function createStageBridgedReceiptInstruction(
  vault: PublicKey,
  receiptAccount: PublicKey,
  walletSigner: PublicKey,
  policyEvalAccount: PublicKey,
  params: StageBridgedReceiptParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  return makeIx(
    Instruction.StageBridgedReceipt,
    encodeReceipt(params.receipt),
    [
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: receiptAccount, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
      { pubkey: policyEvalAccount, isSigner: false, isWritable: false },
    ],
    programId
  );
}

export function createInitRecoveryInstruction(
  recoveryAccount: PublicKey,
  vault: PublicKey,
  params: InitRecoveryParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(75);
  let off = 0;
  off = writePubkey(buf, off, params.vaultPubkey);
  off = writeBytes(buf, off, params.recoveryCommitment);
  off = writeU64LE(buf, off, params.expirySlot);
  off = writeU8(buf, off, params.newThreshold);
  off = writeU8(buf, off, params.newParticipantCount);
  writeU8(buf, off, params.bump);
  return makeIx(
    Instruction.InitRecovery,
    buf,
    [
      { pubkey: recoveryAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
    ],
    programId
  );
}

export function createCompleteRecoveryInstruction(
  recoveryAccount: PublicKey,
  params: CompleteRecoveryParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(64);
  let off = 0;
  off = writeBytes(buf, off, params.newGroupKey);
  writeBytes(buf, off, params.newAuthorityHash);
  return makeIx(
    Instruction.CompleteRecovery,
    buf,
    [{ pubkey: recoveryAccount, isSigner: false, isWritable: true }],
    programId
  );
}

export function createMigrateAuthorityInstruction(
  authority: PublicKey,
  params: MigrateAuthorityParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  return makeIx(
    Instruction.MigrateAuthority,
    params.newAuthorityRoot,
    [{ pubkey: authority, isSigner: false, isWritable: true }],
    programId
  );
}

export function createAdvancePolicyVersionInstruction(
  vault: PublicKey,
  params: AdvancePolicyVersionParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
): TransactionInstruction {
  const buf = new Uint8Array(8);
  writeU64LE(buf, 0, params.newVersion);
  return makeIx(
    Instruction.AdvancePolicyVersion,
    buf,
    [{ pubkey: vault, isSigner: false, isWritable: true }],
    programId
  );
}
