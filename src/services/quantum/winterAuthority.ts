const WINTER_AUTHORITY_MESSAGE_SCALARS = 22;
const WINTER_AUTHORITY_CHECKSUM_SCALARS = 2;
const WINTER_AUTHORITY_TOTAL_SCALARS =
  WINTER_AUTHORITY_MESSAGE_SCALARS + WINTER_AUTHORITY_CHECKSUM_SCALARS;
const WINTER_AUTHORITY_SCALAR_BYTES = 32;
const WINTER_AUTHORITY_SIGNATURE_BYTES =
  WINTER_AUTHORITY_TOTAL_SCALARS * WINTER_AUTHORITY_SCALAR_BYTES;
const WINTER_AUTHORITY_DOMAIN = new TextEncoder().encode("VAULKYRIE_WINTER_AUTHORITY_V1");
const WINTER_AUTHORITY_ADVANCE_DOMAIN = new TextEncoder().encode("VAULKYRIE_WINTER_AUTHORITY_ADVANCE");

export {
  WINTER_AUTHORITY_MESSAGE_SCALARS,
  WINTER_AUTHORITY_CHECKSUM_SCALARS,
  WINTER_AUTHORITY_TOTAL_SCALARS,
  WINTER_AUTHORITY_SCALAR_BYTES,
  WINTER_AUTHORITY_SIGNATURE_BYTES,
};

export interface WinterAuthorityKeyPair {
  secretScalars: Uint8Array[];
  publicScalars: Uint8Array[];
  root: Uint8Array;
}

export interface WinterAuthoritySignerState {
  current: WinterAuthorityKeyPair;
  next: WinterAuthorityKeyPair;
  sequence: bigint;
}

export interface SerializedWinterAuthoritySignerState {
  currentSecretScalars: string[];
  nextSecretScalars: string[];
  sequence: string;
}

export interface WinterAuthorityAdvanceStatement {
  actionHash: Uint8Array;
  currentRoot: Uint8Array;
  nextRoot: Uint8Array;
  sequence: bigint;
  expirySlot: bigint;
}

export interface SignedWinterAuthorityAdvance {
  statement: WinterAuthorityAdvanceStatement;
  signature: Uint8Array;
  digest: Uint8Array;
  stateToPersistBeforeSend: WinterAuthoritySignerState;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(data).buffer as ArrayBuffer);
  return new Uint8Array(hash);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u64Le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function assertByteLength(value: Uint8Array, length: number, label: string): void {
  if (value.length !== length) {
    throw new Error(`${label} must be ${length} bytes, got ${value.length}.`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

async function chainHash(value: Uint8Array, steps: number): Promise<Uint8Array> {
  let current = new Uint8Array(value);
  for (let index = 0; index < steps; index += 1) {
    current = new Uint8Array(await sha256(current));
  }
  return current;
}

function checksumScalars(digest: Uint8Array): [number, number] {
  let checksum = 0;
  for (const digit of digest) {
    checksum += 255 - digit;
  }
  return [(checksum >> 8) & 0xff, checksum & 0xff];
}

async function leafHash(scalar: Uint8Array): Promise<Uint8Array> {
  return sha256(concatBytes([new Uint8Array([0]), scalar]));
}

async function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256(concatBytes([new Uint8Array([1]), left, right]));
}

export async function winterAuthorityDigest(parts: Uint8Array[]): Promise<Uint8Array> {
  const digest = await sha256(concatBytes([WINTER_AUTHORITY_DOMAIN, ...parts]));
  return digest.slice(0, WINTER_AUTHORITY_MESSAGE_SCALARS);
}

export async function winterAuthorityRoot(publicScalars: Uint8Array[]): Promise<Uint8Array> {
  if (publicScalars.length !== WINTER_AUTHORITY_TOTAL_SCALARS) {
    throw new Error(
      `Winter authority public key must contain ${WINTER_AUTHORITY_TOTAL_SCALARS} scalars.`,
    );
  }

  let level: Uint8Array[] = [];
  for (const scalar of publicScalars) {
    assertByteLength(scalar, WINTER_AUTHORITY_SCALAR_BYTES, "Winter authority scalar");
    level.push(await leafHash(scalar));
  }

  while (level.length > 1) {
    const nextLevel: Uint8Array[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      nextLevel.push(await nodeHash(left, right));
    }
    level = nextLevel;
  }

  return level[0];
}

export async function generateWinterAuthorityKeyPair(): Promise<WinterAuthorityKeyPair> {
  const secretScalars: Uint8Array[] = [];
  const publicScalars: Uint8Array[] = [];

  for (let index = 0; index < WINTER_AUTHORITY_TOTAL_SCALARS; index += 1) {
    const scalar = new Uint8Array(WINTER_AUTHORITY_SCALAR_BYTES);
    crypto.getRandomValues(scalar);
    secretScalars.push(scalar);
    publicScalars.push(await chainHash(scalar, 255));
  }

  return {
    secretScalars,
    publicScalars,
    root: await winterAuthorityRoot(publicScalars),
  };
}

export async function createWinterAuthoritySignerState(
  sequence: bigint = 0n,
): Promise<WinterAuthoritySignerState> {
  return {
    current: await generateWinterAuthorityKeyPair(),
    next: await generateWinterAuthorityKeyPair(),
    sequence,
  };
}

export async function signWinterAuthorityDigest(
  digest: Uint8Array,
  secretScalars: Uint8Array[],
): Promise<Uint8Array> {
  assertByteLength(digest, WINTER_AUTHORITY_MESSAGE_SCALARS, "Winter authority digest");
  if (secretScalars.length !== WINTER_AUTHORITY_TOTAL_SCALARS) {
    throw new Error(
      `Winter authority secret key must contain ${WINTER_AUTHORITY_TOTAL_SCALARS} scalars.`,
    );
  }

  const checksum = checksumScalars(digest);
  const signature = new Uint8Array(WINTER_AUTHORITY_SIGNATURE_BYTES);
  const digits = [...digest, ...checksum];

  for (let index = 0; index < digits.length; index += 1) {
    const secret = secretScalars[index];
    assertByteLength(secret, WINTER_AUTHORITY_SCALAR_BYTES, "Winter authority secret scalar");
    signature.set(await chainHash(secret, digits[index]), index * WINTER_AUTHORITY_SCALAR_BYTES);
  }

  return signature;
}

export async function verifyWinterAuthorityDigest(
  digest: Uint8Array,
  signature: Uint8Array,
  expectedRoot: Uint8Array,
): Promise<boolean> {
  if (
    digest.length !== WINTER_AUTHORITY_MESSAGE_SCALARS ||
    signature.length !== WINTER_AUTHORITY_SIGNATURE_BYTES ||
    expectedRoot.length !== WINTER_AUTHORITY_SCALAR_BYTES
  ) {
    return false;
  }

  const checksum = checksumScalars(digest);
  const digits = [...digest, ...checksum];
  const publicScalars: Uint8Array[] = [];

  for (let index = 0; index < digits.length; index += 1) {
    const start = index * WINTER_AUTHORITY_SCALAR_BYTES;
    const scalar = signature.slice(start, start + WINTER_AUTHORITY_SCALAR_BYTES);
    publicScalars.push(await chainHash(scalar, 255 - digits[index]));
  }

  return equalBytes(await winterAuthorityRoot(publicScalars), expectedRoot);
}

export async function winterAuthorityAdvanceDigest(
  statement: WinterAuthorityAdvanceStatement,
): Promise<Uint8Array> {
  assertByteLength(statement.actionHash, 32, "Winter authority action hash");
  assertByteLength(statement.currentRoot, 32, "Winter authority current root");
  assertByteLength(statement.nextRoot, 32, "Winter authority next root");

  return winterAuthorityDigest([
    WINTER_AUTHORITY_ADVANCE_DOMAIN,
    statement.actionHash,
    statement.currentRoot,
    statement.nextRoot,
    u64Le(statement.sequence),
    u64Le(statement.expirySlot),
  ]);
}

export async function signWinterAuthorityAdvance(
  state: WinterAuthoritySignerState,
  statement: WinterAuthorityAdvanceStatement,
): Promise<SignedWinterAuthorityAdvance> {
  if (state.sequence !== statement.sequence) {
    throw new Error("Winter authority sequence does not match local signer state.");
  }
  if (!equalBytes(state.current.root, statement.currentRoot)) {
    throw new Error("Winter authority current root does not match local signer state.");
  }
  if (!equalBytes(state.next.root, statement.nextRoot)) {
    throw new Error("Winter authority next root does not match staged signer state.");
  }

  const digest = await winterAuthorityAdvanceDigest(statement);
  const signature = await signWinterAuthorityDigest(digest, state.current.secretScalars);
  const verified = await verifyWinterAuthorityDigest(digest, signature, state.current.root);
  if (!verified) {
    throw new Error("Winter authority signature failed local verification.");
  }

  return {
    statement,
    signature,
    digest,
    stateToPersistBeforeSend: {
      current: state.next,
      next: await generateWinterAuthorityKeyPair(),
      sequence: state.sequence + 1n,
    },
  };
}

export function winterAuthorityBytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function winterAuthorityHexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Hex string must have an even length.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    out[index / 2] = parseInt(hex.slice(index, index + 2), 16);
  }
  return out;
}

export function serializeWinterAuthoritySignerState(
  state: WinterAuthoritySignerState,
): string {
  return JSON.stringify({
    currentSecretScalars: state.current.secretScalars.map(winterAuthorityBytesToHex),
    nextSecretScalars: state.next.secretScalars.map(winterAuthorityBytesToHex),
    sequence: state.sequence.toString(),
  } satisfies SerializedWinterAuthoritySignerState);
}

async function keyPairFromSecretScalars(secretScalars: Uint8Array[]): Promise<WinterAuthorityKeyPair> {
  if (secretScalars.length !== WINTER_AUTHORITY_TOTAL_SCALARS) {
    throw new Error(
      `Winter authority state must contain ${WINTER_AUTHORITY_TOTAL_SCALARS} secret scalars.`,
    );
  }

  const publicScalars: Uint8Array[] = [];
  for (const scalar of secretScalars) {
    assertByteLength(scalar, WINTER_AUTHORITY_SCALAR_BYTES, "Winter authority secret scalar");
    publicScalars.push(await chainHash(scalar, 255));
  }

  return {
    secretScalars,
    publicScalars,
    root: await winterAuthorityRoot(publicScalars),
  };
}

export async function deserializeWinterAuthoritySignerState(
  serialized: string,
): Promise<WinterAuthoritySignerState> {
  const parsed = JSON.parse(serialized) as Partial<SerializedWinterAuthoritySignerState>;
  if (
    !Array.isArray(parsed.currentSecretScalars) ||
    !Array.isArray(parsed.nextSecretScalars) ||
    typeof parsed.sequence !== "string"
  ) {
    throw new Error("Invalid Winter authority signer state.");
  }

  return {
    current: await keyPairFromSecretScalars(parsed.currentSecretScalars.map(winterAuthorityHexToBytes)),
    next: await keyPairFromSecretScalars(parsed.nextSecretScalars.map(winterAuthorityHexToBytes)),
    sequence: BigInt(parsed.sequence),
  };
}
