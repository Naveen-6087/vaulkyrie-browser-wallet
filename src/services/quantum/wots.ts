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

import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

// ── Constants ────────────────────────────────────────────────────────

const CHAINS = 16;
const CHAIN_LEN = 15;
const HASH_LEN = 32;
const WOTS_PUBKEY_LEN = CHAINS * HASH_LEN;  // 512
const WOTS_SIG_LEN = CHAINS * HASH_LEN;     // 512
const HARDENED_OFFSET = 0x80000000;
const VAULKYRIE_WOTS_DERIVATION_DOMAIN = new TextEncoder().encode("Vaulkyrie PQC seed v1");

export { CHAINS, CHAIN_LEN, HASH_LEN, WOTS_PUBKEY_LEN, WOTS_SIG_LEN };

// ── SHA-256 wrapper ──────────────────────────────────────────────────

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(data).buffer as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(hash);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
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

export interface PqcSigningPosition {
  wallet: number;
  parent: number;
  child: number;
}

// ── XMSS Tree Types ─────────────────────────────────────────────────

export interface XmssTree {
  /** All WOTS+ key pairs (one per leaf) */
  keys: WotsKeyPair[];
  /** Merkle tree root hash stored as the on-chain authority root */
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

function assertDerivationIndex(index: number, label: string) {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
    throw new Error(`${label} derivation index must be an integer from 0 to ${HARDENED_OFFSET - 1}.`);
  }
}

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
}

function u32Be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint32(0, value, false);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hmacSha512(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(data)));
}

async function deriveHardenedNode(
  key: Uint8Array,
  chainCode: Uint8Array,
  index: number,
): Promise<{ key: Uint8Array; chainCode: Uint8Array }> {
  assertDerivationIndex(index, "PQC");
  const data = concatBytes(new Uint8Array([0]), key, u32Be(index + HARDENED_OFFSET));
  const digest = await hmacSha512(chainCode, data);
  return {
    key: digest.slice(0, HASH_LEN),
    chainCode: digest.slice(HASH_LEN),
  };
}

async function keyPairFromSecretElements(secretElements: Uint8Array[]): Promise<WotsKeyPair> {
  if (secretElements.length !== CHAINS) {
    throw new Error(`WOTS key must have ${CHAINS} secret elements.`);
  }

  const publicElements: Uint8Array[] = [];
  for (let i = 0; i < CHAINS; i++) {
    if (secretElements[i].length !== HASH_LEN) {
      throw new Error(`WOTS secret element ${i} must be ${HASH_LEN} bytes.`);
    }
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

/** Generate a single WOTS+ key pair */
export async function generateWotsKeyPair(): Promise<WotsKeyPair> {
  // Generate 16 random 32-byte secret elements
  const secretElements: Uint8Array[] = [];
  for (let i = 0; i < CHAINS; i++) {
    const element = new Uint8Array(HASH_LEN);
    crypto.getRandomValues(element);
    secretElements.push(element);
  }

  return keyPairFromSecretElements(secretElements);
}

export function generatePqcMnemonic(strength: 128 | 256 = 256): string {
  return generateMnemonic(wordlist, strength);
}

export function validatePqcMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

export async function mnemonicToPqcSeed(mnemonic: string, passphrase = ""): Promise<Uint8Array> {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("Enter a valid BIP39 recovery phrase.");
  }
  return mnemonicToSeed(normalized, passphrase);
}

export function nextPqcSigningPosition(position: PqcSigningPosition): PqcSigningPosition {
  assertDerivationIndex(position.wallet, "Wallet");
  assertDerivationIndex(position.parent, "Parent");
  assertDerivationIndex(position.child, "Child");

  if (position.child < HARDENED_OFFSET - 1) {
    return { ...position, child: position.child + 1 };
  }
  if (position.parent < HARDENED_OFFSET - 1) {
    return { wallet: position.wallet, parent: position.parent + 1, child: 0 };
  }
  if (position.wallet < HARDENED_OFFSET - 1) {
    return { wallet: position.wallet + 1, parent: 0, child: 0 };
  }
  throw new Error("PQC BIP39 derivation space is exhausted.");
}

export async function deriveWotsKeyPairFromSeed(
  seed: Uint8Array,
  position: PqcSigningPosition = { wallet: 0, parent: 0, child: 0 },
): Promise<WotsKeyPair> {
  assertDerivationIndex(position.wallet, "Wallet");
  assertDerivationIndex(position.parent, "Parent");
  assertDerivationIndex(position.child, "Child");

  const master = await hmacSha512(VAULKYRIE_WOTS_DERIVATION_DOMAIN, seed);
  let node: { key: Uint8Array; chainCode: Uint8Array } = {
    key: master.slice(0, HASH_LEN),
    chainCode: master.slice(HASH_LEN),
  };

  for (const index of [position.wallet, position.parent, position.child]) {
    node = await deriveHardenedNode(node.key, node.chainCode, index);
  }

  const secretElements: Uint8Array[] = [];
  for (let i = 0; i < CHAINS; i++) {
    const element = await deriveHardenedNode(node.key, node.chainCode, i);
    secretElements.push(element.key);
  }

  return keyPairFromSecretElements(secretElements);
}

export async function deriveWotsKeyPairFromMnemonic(
  mnemonic: string,
  position: PqcSigningPosition = { wallet: 0, parent: 0, child: 0 },
  passphrase = "",
): Promise<WotsKeyPair> {
  const seed = await mnemonicToPqcSeed(mnemonic, passphrase);
  return deriveWotsKeyPairFromSeed(seed, position);
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
 * Leaf 0 becomes the initial authority hash and the root becomes the
 * authority root on-chain.
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

export function getInitialXmssAuthorityHash(tree: XmssTree): Uint8Array {
  const initialKey = tree.keys[0];
  if (!initialKey) {
    throw new Error("XMSS tree has no leaves.");
  }

  return new Uint8Array(initialKey.publicKeyHash);
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
 * Construct the root-rolling PQC wallet advance message.
 * Matches vaulkyrie-protocol::pqc_wallet_advance_message.
 */
export async function pqcWalletAdvanceMessage(
  walletId: Uint8Array,
  currentRoot: Uint8Array,
  nextRoot: Uint8Array,
  destination: Uint8Array,
  amount: bigint,
  sequence: bigint,
): Promise<Uint8Array> {
  const domain = new TextEncoder().encode("VAULKYRIE_PQC_WALLET_ADVANCE_V1");
  const domainHash = await sha256(domain);
  const msg = new Uint8Array(176);
  const view = new DataView(msg.buffer);
  msg.set(domainHash, 0);
  msg.set(walletId, 32);
  msg.set(currentRoot, 64);
  msg.set(nextRoot, 96);
  msg.set(destination, 128);
  view.setBigUint64(160, amount, true);
  view.setBigUint64(168, sequence, true);
  return msg;
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
