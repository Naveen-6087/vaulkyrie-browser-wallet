import { Keypair } from "@solana/web3.js";
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const PRIVACY_VAULT_DERIVATION_PATH = "m/44'/501'/0'/0'";
const HARDENED_OFFSET = 0x80000000;
const ED25519_SEED_DOMAIN = new TextEncoder().encode("ed25519 seed");

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
}

export function generatePrivacyVaultMnemonic(strength: 128 | 256 = 256): string {
  return generateMnemonic(wordlist, strength);
}

export function validatePrivacyVaultMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

function cloneBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const clone = new Uint8Array(new ArrayBuffer(bytes.length));
  clone.set(bytes);
  return clone;
}

function parseDerivationPath(path: string): number[] {
  const segments = path.split("/");
  if (segments[0] !== "m") {
    throw new Error("Derivation path must start with m.");
  }

  return segments.slice(1).map((segment) => {
    if (!segment.endsWith("'")) {
      throw new Error("Privacy Vault derivation must use hardened path segments only.");
    }
    const value = Number.parseInt(segment.slice(0, -1), 10);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error("Privacy Vault derivation path contains an invalid segment.");
    }
    return value + HARDENED_OFFSET;
  });
}

async function hmacSha512(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const keyData = cloneBytes(keyBytes);
  const messageData = cloneBytes(data);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  return new Uint8Array(signature);
}

async function deriveEd25519Node(
  key: Uint8Array,
  chainCode: Uint8Array,
  index: number,
): Promise<{ key: Uint8Array<ArrayBuffer>; chainCode: Uint8Array<ArrayBuffer> }> {
  const data = new Uint8Array(1 + key.length + 4);
  data[0] = 0;
  data.set(key, 1);
  const view = new DataView(data.buffer);
  view.setUint32(1 + key.length, index, false);
  const digest = await hmacSha512(chainCode, data);
  return {
    key: cloneBytes(digest.slice(0, 32)),
    chainCode: cloneBytes(digest.slice(32)),
  };
}

export async function derivePrivacyVaultKeypairFromMnemonic(
  mnemonic: string,
  derivationPath: string = PRIVACY_VAULT_DERIVATION_PATH,
): Promise<Keypair> {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("Enter a valid BIP39 recovery phrase.");
  }

  const seed = await mnemonicToSeed(normalized);
  const master = await hmacSha512(ED25519_SEED_DOMAIN, cloneBytes(Uint8Array.from(seed)));
  let node: { key: Uint8Array<ArrayBuffer>; chainCode: Uint8Array<ArrayBuffer> } = {
    key: cloneBytes(master.slice(0, 32)),
    chainCode: cloneBytes(master.slice(32)),
  };

  for (const index of parseDerivationPath(derivationPath)) {
    node = await deriveEd25519Node(node.key, node.chainCode, index);
  }

  return Keypair.fromSeed(node.key);
}

export function normalizePrivacyVaultMnemonic(mnemonic: string): string {
  return normalizeMnemonic(mnemonic);
}
