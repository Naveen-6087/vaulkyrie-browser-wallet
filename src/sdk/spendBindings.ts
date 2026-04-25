import { ActionKind } from "./constants";

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function u64ToLeBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, value, true);
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function sha256Bytes(...chunks: Uint8Array[]): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(concatBytes(chunks)));
  return new Uint8Array(digest);
}

export function generateSpendSessionNonce(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const view = new DataView(bytes.buffer);
  return view.getBigUint64(0, true);
}

export async function buildSpendActionHash(params: {
  vaultId: Uint8Array;
  recipient: string;
  amountAtomic: string;
  tokenSymbol: string;
  tokenMint: string | null;
  policyVersion: bigint;
  sessionNonce: bigint;
}): Promise<Uint8Array> {
  const payloadHash = await sha256Bytes(
    utf8(JSON.stringify({
      sessionNonce: params.sessionNonce.toString(),
      recipient: params.recipient,
      amountAtomic: params.amountAtomic,
      tokenSymbol: params.tokenSymbol,
      tokenMint: params.tokenMint,
    })),
  );

  return sha256Bytes(
    params.vaultId,
    payloadHash,
    u64ToLeBytes(params.policyVersion),
    Uint8Array.of(ActionKind.Spend),
  );
}

export async function buildSpendOrchestrationBindings(params: {
  actionHash: Uint8Array;
  messageBytes: Uint8Array;
  signerIds: number[];
  threshold: number;
  participantCount: number;
  expirySlot: bigint;
}): Promise<{
  sessionCommitment: Uint8Array;
  signersCommitment: Uint8Array;
  signingPackageHash: Uint8Array;
  txBinding: Uint8Array;
}> {
  const signerBytes = Uint8Array.from(params.signerIds);
  const messageHash = await sha256Bytes(params.messageBytes);
  const signersCommitment = await sha256Bytes(
    utf8("vaulkyrie:signers:v1"),
    signerBytes,
    Uint8Array.of(params.threshold, params.participantCount),
  );
  const sessionCommitment = await sha256Bytes(
    utf8("vaulkyrie:session:v1"),
    params.actionHash,
    messageHash,
    u64ToLeBytes(params.expirySlot),
  );
  const signingPackageHash = await sha256Bytes(
    utf8("vaulkyrie:signing-package:v1"),
    params.actionHash,
    messageHash,
    signersCommitment,
  );
  const txBinding = await sha256Bytes(
    utf8("vaulkyrie:tx-binding:v1"),
    params.actionHash,
    messageHash,
  );

  return {
    sessionCommitment,
    signersCommitment,
    signingPackageHash,
    txBinding,
  };
}
