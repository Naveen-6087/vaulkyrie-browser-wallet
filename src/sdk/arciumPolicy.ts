import {
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  RescueCipher,
  getArciumProgramId,
  getClusterAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getFeePoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  getMempoolAccAddress,
  x25519,
} from "@arcium-hq/client";
import { Buffer } from "buffer";
import { VAULKYRIE_POLICY_MXE_PROGRAM_ID } from "./constants";
import type { PolicyEvaluationAccount } from "./types";

export const ARCIUM_DEVNET_CLUSTER_OFFSET = 456;
export const POLICY_EVALUATE_COMP_DEF_OFFSET = 3285788639;

const QUEUE_POLICY_EVALUATE_DISC = new Uint8Array([
  0x24, 0x88, 0x75, 0x2e, 0x84, 0x89, 0x18, 0x5c,
]);
const SIGN_PDA_SEED = "ArciumSignerAccount";
const COMPUTATION_ACC_SEED = "ComputationAccount";
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export interface PolicyEvaluateArciumAccounts {
  mxeAccount: PublicKey;
  signPdaAccount: PublicKey;
  mempoolAccount: PublicKey;
  executingPool: PublicKey;
  computationAccount: PublicKey;
  compDefAccount: PublicKey;
  clusterAccount: PublicKey;
  poolAccount: PublicKey;
  arciumProgram: PublicKey;
}

export interface EncryptedPolicyEvaluateInput {
  encryptedInput: Uint8Array;
  x25519Pubkey: Uint8Array;
  nonce: bigint;
}

function assertBytes(name: string, value: Uint8Array, expected: number) {
  if (value.length !== expected) {
    throw new Error(`${name} must be ${expected} bytes, got ${value.length}.`);
  }
}

function assertRange(name: string, value: bigint, max: bigint) {
  if (value < 0n || value > max) {
    throw new Error(`${name} is out of range.`);
  }
}

function writeU64LE(buf: Uint8Array, offset: number, value: bigint): number {
  assertRange("u64", value, U64_MAX);
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigUint64(offset, value, true);
  return offset + 8;
}

function writeU128LE(buf: Uint8Array, offset: number, value: bigint): number {
  assertRange("u128", value, U128_MAX);
  let cursor = value;
  for (let i = 0; i < 16; i += 1) {
    buf[offset + i] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  return offset + 16;
}

function writeBytes(buf: Uint8Array, offset: number, src: Uint8Array): number {
  buf.set(src, offset);
  return offset + src.length;
}

function u32Le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

function u64Le(value: bigint): Buffer {
  assertRange("computation offset", value, U64_MAX);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function readonlyAnchorProvider(connection: Connection, publicKey: PublicKey): AnchorProvider {
  return new AnchorProvider(
    connection,
    {
      publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
        void tx;
        throw new Error("Arcium policy encryption does not sign transactions.");
      },
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(
        txs: T[],
      ): Promise<T[]> => {
        void txs;
        throw new Error("Arcium policy encryption does not sign transactions.");
      },
    },
    { commitment: "confirmed" },
  );
}

export function derivePolicyMxeAccount(
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID,
): PublicKey {
  return getMXEAccAddress(programId);
}

export function deriveArciumSignerPda(
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(SIGN_PDA_SEED)], programId)[0];
}

export function deriveComputationAccount(
  computationOffset: bigint,
  clusterOffset = ARCIUM_DEVNET_CLUSTER_OFFSET,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(COMPUTATION_ACC_SEED), u32Le(clusterOffset), u64Le(computationOffset)],
    getArciumProgramId(),
  )[0];
}

export function derivePolicyEvaluateArciumAccounts(
  computationOffset: bigint,
  clusterOffset = ARCIUM_DEVNET_CLUSTER_OFFSET,
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID,
): PolicyEvaluateArciumAccounts {
  return {
    mxeAccount: getMXEAccAddress(programId),
    signPdaAccount: deriveArciumSignerPda(programId),
    mempoolAccount: getMempoolAccAddress(clusterOffset),
    executingPool: getExecutingPoolAccAddress(clusterOffset),
    computationAccount: deriveComputationAccount(computationOffset, clusterOffset),
    compDefAccount: getCompDefAccAddress(programId, POLICY_EVALUATE_COMP_DEF_OFFSET),
    clusterAccount: getClusterAccAddress(clusterOffset),
    poolAccount: getFeePoolAccAddress(),
    arciumProgram: getArciumProgramId(),
  };
}

export async function assertPolicyEvaluateArciumReady(
  connection: Connection,
  computationOffset: bigint,
  clusterOffset = ARCIUM_DEVNET_CLUSTER_OFFSET,
): Promise<PolicyEvaluateArciumAccounts> {
  const accounts = derivePolicyEvaluateArciumAccounts(computationOffset, clusterOffset);
  const checks = [
    ["MXE account", accounts.mxeAccount],
    ["mempool account", accounts.mempoolAccount],
    ["executing pool", accounts.executingPool],
    ["computation definition", accounts.compDefAccount],
    ["cluster account", accounts.clusterAccount],
    ["fee pool", accounts.poolAccount],
  ] as const;

  const infos = await connection.getMultipleAccountsInfo(checks.map(([, key]) => key));
  const missing = checks
    .filter((_, index) => infos[index] === null)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Arcium policy queue is not initialized on devnet: missing ${missing.join(", ")}.`,
    );
  }

  return accounts;
}

export async function encryptPolicyEvaluateInput(
  connection: Connection,
  payer: PublicKey,
  evaluation: PolicyEvaluationAccount,
): Promise<EncryptedPolicyEvaluateInput> {
  const provider = readonlyAnchorProvider(connection, payer);
  const mxePublicKey = await getMXEPublicKey(provider, VAULKYRIE_POLICY_MXE_PROGRAM_ID);
  if (!mxePublicKey) {
    throw new Error("Arcium MXE x25519 public key is not available for this policy program.");
  }

  const privateKey = x25519.utils.randomSecretKey();
  const x25519Pubkey = x25519.getPublicKey(privateKey);
  const nonceBytes = randomBytes(16);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  const policySignal = BigInt(evaluation.encryptedInputCommitment[0]);
  const encrypted = cipher.encrypt([policySignal], nonceBytes);
  const encryptedInput = new Uint8Array(encrypted[0]);

  assertBytes("encrypted policy input", encryptedInput, 32);
  assertBytes("x25519 public key", x25519Pubkey, 32);

  return {
    encryptedInput,
    x25519Pubkey,
    nonce: bytesToBigIntLE(nonceBytes),
  };
}

export function nextPolicyComputationOffset(): bigint {
  const random = bytesToBigIntLE(randomBytes(2));
  return (BigInt(Date.now()) << 16n) | random;
}

export function createQueuePolicyEvaluateInstruction(
  evaluation: PublicKey,
  payer: PublicKey,
  params: {
    computationOffset: bigint;
    encryptedInput: Uint8Array;
    x25519Pubkey: Uint8Array;
    nonce: bigint;
    clusterOffset?: number;
  },
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID,
): TransactionInstruction {
  assertBytes("encrypted policy input", params.encryptedInput, 32);
  assertBytes("x25519 public key", params.x25519Pubkey, 32);

  const accounts = derivePolicyEvaluateArciumAccounts(
    params.computationOffset,
    params.clusterOffset,
    programId,
  );
  const data = new Uint8Array(8 + 8 + 32 + 32 + 16);
  let off = 0;
  off = writeBytes(data, off, QUEUE_POLICY_EVALUATE_DISC);
  off = writeU64LE(data, off, params.computationOffset);
  off = writeBytes(data, off, params.encryptedInput);
  off = writeBytes(data, off, params.x25519Pubkey);
  writeU128LE(data, off, params.nonce);

  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: evaluation, isSigner: false, isWritable: true },
      { pubkey: accounts.mxeAccount, isSigner: false, isWritable: false },
      { pubkey: accounts.signPdaAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.mempoolAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.executingPool, isSigner: false, isWritable: true },
      { pubkey: accounts.computationAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.compDefAccount, isSigner: false, isWritable: false },
      { pubkey: accounts.clusterAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.poolAccount, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: accounts.arciumProgram, isSigner: false, isWritable: false },
    ],
    programId,
    data: Buffer.from(data),
  });
}
