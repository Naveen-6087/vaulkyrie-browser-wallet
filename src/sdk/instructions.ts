import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { Instruction, VAULKYRIE_CORE_PROGRAM_ID } from "./constants";
import type {
  AdvancePqcWalletParams,
  CommitSpendOrchestrationParams,
  CompleteRecoveryParams,
  CompleteSpendOrchestrationParams,
  InitAuthorityParams,
  InitPqcWalletParams,
  InitRecoveryParams,
  InitSpendOrchestrationParams,
  InitVaultParams,
  SetVaultStatusParams,
} from "./types";

function writeU8(buf: Uint8Array, offset: number, val: number): number {
  buf[offset] = val & 0xff;
  return offset + 1;
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

function writePubkey(buf: Uint8Array, offset: number, key: PublicKey): number {
  return writeBytes(buf, offset, key.toBytes());
}

function makeIx(
  tag: (typeof Instruction)[keyof typeof Instruction],
  data: Uint8Array,
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
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

export function createInitVaultInstruction(
  vaultRegistry: PublicKey,
  walletSigner: PublicKey,
  params: InitVaultParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
): TransactionInstruction {
  const buf = new Uint8Array(65);
  let off = 0;
  off = writePubkey(buf, off, params.walletPubkey);
  off = writeBytes(buf, off, params.authorityHash);
  writeU8(buf, off, params.bump);
  return makeIx(
    Instruction.InitVault,
    buf,
    [
      { pubkey: vaultRegistry, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
  );
}

export function createInitAuthorityInstruction(
  authority: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: InitAuthorityParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
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
    programId,
  );
}

export function createInitPqcWalletInstruction(
  payer: PublicKey,
  wallet: PublicKey,
  params: InitPqcWalletParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
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
    programId,
  );
}

export function createAdvancePqcWalletInstruction(
  wallet: PublicKey,
  destination: PublicKey,
  params: AdvancePqcWalletParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
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
    programId,
  );
}

export function createSetVaultStatusInstruction(
  vault: PublicKey,
  walletSigner: PublicKey,
  params: SetVaultStatusParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
): TransactionInstruction {
  const buf = new Uint8Array([params.status]);
  return makeIx(
    Instruction.SetVaultStatus,
    buf,
    [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: walletSigner, isSigner: true, isWritable: false },
    ],
    programId,
  );
}

export function createInitSpendOrchestrationInstruction(
  orchAccount: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: InitSpendOrchestrationParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
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
    programId,
  );
}

export function createCommitSpendOrchestrationInstruction(
  orchAccount: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: CommitSpendOrchestrationParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
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
    programId,
  );
}

export function createCompleteSpendOrchestrationInstruction(
  orchAccount: PublicKey,
  vault: PublicKey,
  walletSigner: PublicKey,
  params: CompleteSpendOrchestrationParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
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
    programId,
  );
}

export function createInitRecoveryInstruction(
  recoveryAccount: PublicKey,
  vault: PublicKey,
  params: InitRecoveryParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
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
    programId,
  );
}

export function createCompleteRecoveryInstruction(
  recoveryAccount: PublicKey,
  params: CompleteRecoveryParams,
  programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID,
): TransactionInstruction {
  const buf = new Uint8Array(64);
  let off = 0;
  off = writeBytes(buf, off, params.newGroupKey);
  writeBytes(buf, off, params.newAuthorityHash);
  return makeIx(
    Instruction.CompleteRecovery,
    buf,
    [{ pubkey: recoveryAccount, isSigner: false, isWritable: true }],
    programId,
  );
}
