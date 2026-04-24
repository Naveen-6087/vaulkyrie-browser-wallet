/**
 * Winternitz One-Time Signature (WOTS+) implementation for quantum vault.
 *
 * Compatible with solana-winternitz crate (16-chain, SHA-256, w=16).
 * Used for post-quantum authority signatures: vault split/close and
 * authority rotation.
 *
 * IMPORTANT: Each WOTS+ key can only sign ONE message. After signing,
 * the key is consumed and must never be reused.
 *
 * Parameters (matching solana-winternitz):
 *   - Hash: SHA-256
 *   - Winternitz parameter w = 16 (4-bit nibbles)
 *   - Chains: 16 (32-byte message → 64 nibbles, but we use 16 chains
 *     with checksum to match the Blueshift implementation)
 *   - Chain length: 15 steps (0..15)
 *   - Public key: 16 × 32 bytes = 512 bytes
 *   - Signature: 16 × 32 bytes = 512 bytes
 *   - Secret key: 16 × 32 bytes = 512 bytes
 */

// ── Constants ────────────────────────────────────────────────────────

const CHAINS = 16;
const CHAIN_LEN = 15;
const HASH_LEN = 32;
const WOTS_PUBKEY_LEN = CHAINS * HASH_LEN;  // 512
const WOTS_SIG_LEN = CHAINS * HASH_LEN;     // 512

export { CHAINS, CHAIN_LEN, HASH_LEN, WOTS_PUBKEY_LEN, WOTS_SIG_LEN };

// ── SHA-256 wrapper ──────────────────────────────────────────────────

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(data).buffer as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(hash);
}

/** Hash a value `n` times: H^n(x) */
async function chainHash(value: Uint8Array, steps: number): Promise<Uint8Array> {
  let current = value;
  for (let i = 0; i < steps; i++) {
    current = await sha256(current);
  }
  return current;
}

// ── WOTS+ Key Types ─────────────────────────────────────────────────

export interface WotsSecretKey {
  /** 16 secret chain seeds, each 32 bytes */
  elements: Uint8Array[];
}

export interface WotsPublicKey {
  /** 16 public chain endpoints, each 32 bytes */
  elements: Uint8Array[];
}

export interface WotsSignature {
  /** 16 chain values at message-dependent positions */
  elements: Uint8Array[];
}

export interface WotsKeyPair {
  secretKey: WotsSecretKey;
  publicKey: WotsPublicKey;
  /** Merkleized public key hash matching solana-winternitz PDA binding */
  publicKeyHash: Uint8Array;
}

// ── XMSS Tree Types ─────────────────────────────────────────────────

export interface XmssTree {
  /** All WOTS+ key pairs (one per leaf) */
  keys: WotsKeyPair[];
  /** Merkle tree root hash (the "authority hash") */
  root: Uint8Array;
  /** Tree depth (log2 of leaf count) */
  depth: number;
  /** Next unused leaf index */
  nextLeafIndex: number;
}

export interface XmssAuthPath {
  /** Sibling hashes from leaf to root */
  siblings: Uint8Array[];
}

interface SerializedXmssTree {
  depth: number;
  nextLeafIndex: number;
  rootHex: string;
  keys: Array<{
    secretKey: string[];
    publicKey: string[];
    publicKeyHash: string;
  }>;
}

interface SerializedWotsKeyPair {
  secretKey: string[];
  publicKey: string[];
  publicKeyHash: string;
}

// ── Key Generation ───────────────────────────────────────────────────

/** Generate a single WOTS+ key pair */
export async function generateWotsKeyPair(): Promise<WotsKeyPair> {
  // Generate 16 random 32-byte secret elements
  const secretElements: Uint8Array[] = [];
  for (let i = 0; i < CHAINS; i++) {
    const element = new Uint8Array(HASH_LEN);
    crypto.getRandomValues(element);
    secretElements.push(element);
  }

  // Compute public key: hash each element CHAIN_LEN times
  const publicElements: Uint8Array[] = [];
  for (let i = 0; i < CHAINS; i++) {
    publicElements.push(await chainHash(secretElements[i], CHAIN_LEN));
  }

  const publicKey = { elements: publicElements };
  const publicKeyHash = await merklizeWotsPublicKey(publicKey);

  return {
    secretKey: { elements: secretElements },
    publicKey,
    publicKeyHash,
  };
}

export async function merklizeWotsPublicKey(publicKey: WotsPublicKey): Promise<Uint8Array> {
  return computeMerkleRoot(publicKey.elements);
}

// ── Message Digest ───────────────────────────────────────────────────

/**
 * Compute checksum nibbles for the message nibbles.
 * Checksum = sum of (CHAIN_LEN - nibble) for each nibble.
 * This prevents an attacker from hashing signature elements further.
 */
function checksumNibbles(msgNibbles: number[]): number[] {
  let checksum = 0;
  for (const n of msgNibbles) {
    checksum += CHAIN_LEN - n;
  }

  // Encode checksum as nibbles (big-endian)
  const csNibbles: number[] = [];
  csNibbles.push((checksum >> 12) & 0x0f);
  csNibbles.push((checksum >> 8) & 0x0f);
  csNibbles.push((checksum >> 4) & 0x0f);
  csNibbles.push(checksum & 0x0f);

  return csNibbles;
}

/**
 * Get the full nibble vector for signing (message nibbles + checksum).
 * Returns exactly 16 nibbles (12 message + 4 checksum) for 16 chains.
 *
 * Note: This uses 12 message nibbles (6 bytes) + 4 checksum nibbles
 * to match the 16-chain constraint of solana-winternitz.
 */
function getSigningNibbles(digest: Uint8Array): number[] {
  // Use 12 message nibbles (first 6 bytes)
  const msgNibbles: number[] = [];
  for (let i = 0; i < 6; i++) {
    msgNibbles.push((digest[i] >> 4) & 0x0f);
    msgNibbles.push(digest[i] & 0x0f);
  }

  const csNibbles = checksumNibbles(msgNibbles);

  // Total: 12 + 4 = 16 nibbles for 16 chains
  return [...msgNibbles, ...csNibbles];
}

// ── Signing ──────────────────────────────────────────────────────────

/**
 * Sign a 32-byte digest with a WOTS+ secret key.
 *
 * For each chain i, compute H^nibble[i](secret[i]).
 * The verifier can then compute H^(CHAIN_LEN - nibble[i])(sig[i])
 * and check it matches public[i].
 *
 * WARNING: This CONSUMES the key. Never reuse a WOTS+ key after signing.
 */
export async function wotsSign(
  digest: Uint8Array,
  secretKey: WotsSecretKey,
): Promise<WotsSignature> {
  if (digest.length !== HASH_LEN) {
    throw new Error(`Digest must be ${HASH_LEN} bytes, got ${digest.length}`);
  }

  const nibbles = getSigningNibbles(digest);
  const sigElements: Uint8Array[] = [];

  for (let i = 0; i < CHAINS; i++) {
    sigElements.push(await chainHash(secretKey.elements[i], nibbles[i]));
  }

  return { elements: sigElements };
}

// ── Verification ─────────────────────────────────────────────────────

/**
 * Verify a WOTS+ signature against a public key and digest.
 *
 * For each chain i, compute H^(CHAIN_LEN - nibble[i])(sig[i])
 * and check it equals public[i].
 */
export async function wotsVerify(
  digest: Uint8Array,
  signature: WotsSignature,
  publicKey: WotsPublicKey,
): Promise<boolean> {
  if (digest.length !== HASH_LEN) return false;

  const nibbles = getSigningNibbles(digest);

  for (let i = 0; i < CHAINS; i++) {
    const remaining = CHAIN_LEN - nibbles[i];
    const computed = await chainHash(signature.elements[i], remaining);

    // Constant-time comparison
    if (computed.length !== publicKey.elements[i].length) return false;
    let diff = 0;
    for (let j = 0; j < computed.length; j++) {
      diff |= computed[j] ^ publicKey.elements[i][j];
    }
    if (diff !== 0) return false;
  }

  return true;
}

export async function wotsSignMessage(
  message: Uint8Array,
  secretKey: WotsSecretKey,
): Promise<WotsSignature> {
  return wotsSign(await sha256(message), secretKey);
}

export async function wotsVerifyMessage(
  message: Uint8Array,
  signature: WotsSignature,
  publicKey: WotsPublicKey,
): Promise<boolean> {
  return wotsVerify(await sha256(message), signature, publicKey);
}

// ── XMSS Tree ────────────────────────────────────────────────────────

/**
 * Generate an XMSS tree with 2^depth WOTS+ key pairs.
 *
 * Default depth = 8 → 256 leaves → 256 one-time signatures.
 * The root hash serves as the "authority hash" on-chain.
 */
export async function generateXmssTree(depth: number = 8): Promise<XmssTree> {
  const leafCount = 1 << depth;
  const keys: WotsKeyPair[] = [];

  // Generate all leaf key pairs
  for (let i = 0; i < leafCount; i++) {
    keys.push(await generateWotsKeyPair());
  }

  // Build Merkle tree from leaf hashes
  const root = await computeMerkleRoot(
    keys.map((k) => k.publicKeyHash),
  );

  return {
    keys,
    root,
    depth,
    nextLeafIndex: 0,
  };
}

/**
 * Generate a small XMSS tree for testing (depth 3 = 8 leaves).
 */
export async function generateSmallXmssTree(): Promise<XmssTree> {
  return generateXmssTree(3);
}

/**
 * Compute the Merkle root from leaf hashes.
 */
async function computeMerkleRoot(
  leaves: Uint8Array[],
): Promise<Uint8Array> {
  let level = leaves.slice();

  while (level.length > 1) {
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      const combined = new Uint8Array(HASH_LEN * 2);
      combined.set(left, 0);
      combined.set(right, HASH_LEN);
      nextLevel.push(await sha256(combined));
    }
    level = nextLevel;
  }

  return level[0];
}

/**
 * Get the authentication path (Merkle proof) for a given leaf index.
 */
export async function getAuthPath(
  tree: XmssTree,
  leafIndex: number,
): Promise<XmssAuthPath> {
  const leaves = tree.keys.map((k) => k.publicKeyHash);
  const siblings: Uint8Array[] = [];

  let level = leaves.slice();
  let idx = leafIndex;

  for (let d = 0; d < tree.depth; d++) {
    // Sibling is the adjacent node
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    siblings.push(
      siblingIdx < level.length
        ? level[siblingIdx]
        : level[level.length - 1],
    );

    // Move up
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      const combined = new Uint8Array(HASH_LEN * 2);
      combined.set(left, 0);
      combined.set(right, HASH_LEN);
      nextLevel.push(await sha256(combined));
    }
    level = nextLevel;
    idx = Math.floor(idx / 2);
  }

  return { siblings };
}

/**
 * Sign a message with the next available WOTS+ key from the XMSS tree.
 * Returns the signature, leaf index, and auth path.
 *
 * Advances nextLeafIndex after signing. Throws if tree is exhausted.
 */
export async function xmssSign(
  tree: XmssTree,
  digest: Uint8Array,
): Promise<{
  signature: WotsSignature;
  publicKey: WotsPublicKey;
  leafIndex: number;
  authPath: XmssAuthPath;
}> {
  const leafCount = 1 << tree.depth;
  if (tree.nextLeafIndex >= leafCount) {
    throw new Error(
      `XMSS tree exhausted: all ${leafCount} leaves consumed. ` +
      `Rotate to a new authority before signing.`,
    );
  }

  const leafIndex = tree.nextLeafIndex;
  const keyPair = tree.keys[leafIndex];

  const signature = await wotsSign(digest, keyPair.secretKey);
  const authPath = await getAuthPath(tree, leafIndex);

  // Consume the leaf
  tree.nextLeafIndex++;

  return {
    signature,
    publicKey: keyPair.publicKey,
    leafIndex,
    authPath,
  };
}

// ── Serialization (wire format) ──────────────────────────────────────

/** Serialize WOTS+ public key to 512 bytes */
export function serializeWotsPublicKey(pk: WotsPublicKey): Uint8Array {
  const out = new Uint8Array(WOTS_PUBKEY_LEN);
  for (let i = 0; i < CHAINS; i++) {
    out.set(pk.elements[i], i * HASH_LEN);
  }
  return out;
}

/** Serialize WOTS+ signature to 512 bytes */
export function serializeWotsSignature(sig: WotsSignature): Uint8Array {
  const out = new Uint8Array(WOTS_SIG_LEN);
  for (let i = 0; i < CHAINS; i++) {
    out.set(sig.elements[i], i * HASH_LEN);
  }
  return out;
}

/** Serialize WotsAuthProof for on-chain submission (matches SDK type) */
export function serializeAuthProof(
  publicKey: WotsPublicKey,
  signature: WotsSignature,
  leafIndex: number,
  authPath: XmssAuthPath,
): Uint8Array {
  // Format: pubkey(512) + sig(512) + leafIndex(4) + authPath(depth * 32)
  const authPathLen = authPath.siblings.length * HASH_LEN;
  const out = new Uint8Array(WOTS_PUBKEY_LEN + WOTS_SIG_LEN + 4 + authPathLen);

  let offset = 0;
  out.set(serializeWotsPublicKey(publicKey), offset);
  offset += WOTS_PUBKEY_LEN;

  out.set(serializeWotsSignature(signature), offset);
  offset += WOTS_SIG_LEN;

  // Little-endian u32 leaf index
  out[offset] = leafIndex & 0xff;
  out[offset + 1] = (leafIndex >> 8) & 0xff;
  out[offset + 2] = (leafIndex >> 16) & 0xff;
  out[offset + 3] = (leafIndex >> 24) & 0xff;
  offset += 4;

  for (const sibling of authPath.siblings) {
    out.set(sibling, offset);
    offset += HASH_LEN;
  }

  return out;
}

// ── Quantum vault message helpers ────────────────────────────────────

/**
 * Construct the split message (amount + split_pubkey + refund_pubkey).
 * Matches vaulkyrie-protocol::quantum_split_message
 */
export function quantumSplitMessage(
  amount: bigint,
  splitPubkey: Uint8Array,
  refundPubkey: Uint8Array,
): Uint8Array {
  const msg = new Uint8Array(72); // 8 + 32 + 32
  // Little-endian u64 amount
  const view = new DataView(msg.buffer);
  view.setBigUint64(0, amount, true);
  msg.set(splitPubkey, 8);
  msg.set(refundPubkey, 40);
  return msg;
}

/**
 * Construct the close message (refund_pubkey only).
 * Matches vaulkyrie-protocol::quantum_close_message
 */
export function quantumCloseMessage(refundPubkey: Uint8Array): Uint8Array {
  return new Uint8Array(refundPubkey);
}

/**
 * Compute the split digest for WOTS+ signing.
 */
export async function quantumSplitDigest(
  amount: bigint,
  splitPubkey: Uint8Array,
  refundPubkey: Uint8Array,
): Promise<Uint8Array> {
  const msg = quantumSplitMessage(amount, splitPubkey, refundPubkey);
  return sha256(msg);
}

/**
 * Compute the close digest for WOTS+ signing.
 */
export async function quantumCloseDigest(
  refundPubkey: Uint8Array,
): Promise<Uint8Array> {
  const msg = quantumCloseMessage(refundPubkey);
  return sha256(msg);
}

// ── Display helpers ──────────────────────────────────────────────────

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function serializeXmssTree(tree: XmssTree): string {
  const serialized: SerializedXmssTree = {
    depth: tree.depth,
    nextLeafIndex: tree.nextLeafIndex,
    rootHex: bytesToHex(tree.root),
    keys: tree.keys.map((key) => ({
      secretKey: key.secretKey.elements.map(bytesToHex),
      publicKey: key.publicKey.elements.map(bytesToHex),
      publicKeyHash: bytesToHex(key.publicKeyHash),
    })),
  };

  return JSON.stringify(serialized);
}

export function deserializeXmssTree(serialized: string): XmssTree {
  const parsed = JSON.parse(serialized) as SerializedXmssTree;

  return {
    depth: parsed.depth,
    nextLeafIndex: parsed.nextLeafIndex,
    root: hexToBytes(parsed.rootHex),
    keys: parsed.keys.map((key) => ({
      secretKey: { elements: key.secretKey.map(hexToBytes) },
      publicKey: { elements: key.publicKey.map(hexToBytes) },
      publicKeyHash: hexToBytes(key.publicKeyHash),
    })),
  };
}

export function serializeWotsKeyPair(keyPair: WotsKeyPair): string {
  const serialized: SerializedWotsKeyPair = {
    secretKey: keyPair.secretKey.elements.map(bytesToHex),
    publicKey: keyPair.publicKey.elements.map(bytesToHex),
    publicKeyHash: bytesToHex(keyPair.publicKeyHash),
  };

  return JSON.stringify(serialized);
}

export function deserializeWotsKeyPair(serialized: string): WotsKeyPair {
  const parsed = JSON.parse(serialized) as SerializedWotsKeyPair;

  return {
    secretKey: { elements: parsed.secretKey.map(hexToBytes) },
    publicKey: { elements: parsed.publicKey.map(hexToBytes) },
    publicKeyHash: hexToBytes(parsed.publicKeyHash),
  };
}
