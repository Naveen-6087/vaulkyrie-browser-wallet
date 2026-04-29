import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
} from "@solana/web3.js";

const DEFAULT_PROGRAM_ID = "HUf5TWL4H18qJigd9m7h6MihX1xnzr2BVbbyGYFLEGPx";
const INIT_PQC_WALLET_INSTRUCTION = 27;
const PQC_WALLET_SPACE = 88;
const FREE_SPONSOR_LIMIT = Number.parseInt(process.env.PQC_SPONSOR_FREE_LIMIT ?? "25", 10);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface SponsoredWalletRecord {
  walletIdHex: string;
  walletAddress: string;
  signature: string;
  network: string;
  sponsoredAt: number;
}

interface SponsorStore {
  records: Record<string, SponsoredWalletRecord>;
}

export interface SponsorPqcInitInput {
  walletIdHex?: string;
  currentRootHex?: string;
  network?: string;
}

const sponsorStorePath = path.resolve(
  process.env.PQC_SPONSOR_STORE_PATH ?? path.join(serverRoot, ".vaulkyrie-sponsored-pqc.json"),
);

const sponsorKeypairPath = path.resolve(
  process.env.PQC_SPONSOR_KEYPAIR_PATH ?? path.join(serverRoot, ".vaulkyrie-pqc-sponsor.json"),
);

function readStore(): SponsorStore {
  if (!existsSync(sponsorStorePath)) {
    return { records: {} };
  }

  try {
    return JSON.parse(readFileSync(sponsorStorePath, "utf8")) as SponsorStore;
  } catch {
    return { records: {} };
  }
}

function writeStore(store: SponsorStore): void {
  writeFileSync(sponsorStorePath, JSON.stringify(store, null, 2));
}

function parseHex32(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value.trim())) {
    throw new Error(`${field} must be a 32-byte hex string.`);
  }

  const hex = value.trim();
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function writeBytes(buf: Uint8Array, offset: number, src: Uint8Array): number {
  buf.set(src, offset);
  return offset + src.length;
}

function resolveNetwork(network?: string): "devnet" | "testnet" | "mainnet-beta" {
  if (network === "mainnet" || network === "mainnet-beta") return "mainnet-beta";
  if (network === "testnet") return "testnet";
  return "devnet";
}

function resolveRpcUrls(network?: string): string[] {
  const resolved = resolveNetwork(network);
  if (resolved === "mainnet-beta" && process.env.PQC_SPONSOR_ALLOW_MAINNET !== "true") {
    throw new Error("PQC sponsorship is disabled for mainnet.");
  }

  return [...new Set([
    process.env.PQC_SPONSOR_RPC_URL?.trim(),
    clusterApiUrl(resolved),
  ].filter((value): value is string => Boolean(value)))];
}

function isRetryableRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  return (
    normalized.includes("403") ||
    normalized.includes("429") ||
    normalized.includes("access forbidden") ||
    normalized.includes("api key is not allowed to access blockchain") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("network request failed")
  );
}

async function withSponsorRpc<T>(
  network: string | undefined,
  operation: (connection: Connection, rpcUrl: string) => Promise<T>,
): Promise<T> {
  const rpcUrls = resolveRpcUrls(network);
  let lastError: unknown;

  for (const rpcUrl of rpcUrls) {
    try {
      return await operation(new Connection(rpcUrl, "confirmed"), rpcUrl);
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || rpcUrl === rpcUrls[rpcUrls.length - 1]) {
        throw error;
      }
      console.warn(`[Vaulkyrie] PQC sponsor RPC ${rpcUrl} failed, retrying cluster fallback.`, error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("All PQC sponsor RPC endpoints failed");
}

function readSponsorKeypair(): Keypair {
  const secret = process.env.PQC_SPONSOR_SECRET_KEY;
  if (secret) {
    const parsed = JSON.parse(secret) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }

  if (existsSync(sponsorKeypairPath)) {
    const parsed = JSON.parse(readFileSync(sponsorKeypairPath, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }

  const keypair = Keypair.generate();
  writeFileSync(sponsorKeypairPath, JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

function getProgramId(): PublicKey {
  return new PublicKey(process.env.VAULKYRIE_CORE_PROGRAM_ID ?? DEFAULT_PROGRAM_ID);
}

function findPqcWalletPda(walletId: Uint8Array, programId = getProgramId()): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pqc_wallet"), Buffer.from(walletId)],
    programId,
  );
}

function createInitPqcWalletInstruction(
  sponsor: PublicKey,
  wallet: PublicKey,
  walletId: Uint8Array,
  currentRoot: Uint8Array,
  bump: number,
): TransactionInstruction {
  const data = new Uint8Array(66);
  let offset = 0;
  data[offset] = INIT_PQC_WALLET_INSTRUCTION;
  offset += 1;
  offset = writeBytes(data, offset, walletId);
  offset = writeBytes(data, offset, currentRoot);
  data[offset] = bump;

  return new TransactionInstruction({
    programId: getProgramId(),
    keys: [
      { pubkey: sponsor, isSigner: true, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function getPqcSponsorStatus(network?: string) {
  const sponsor = readSponsorKeypair();
  const store = readStore();
  const used = Object.keys(store.records).length;
  const limit = Number.isFinite(FREE_SPONSOR_LIMIT) && FREE_SPONSOR_LIMIT > 0 ? FREE_SPONSOR_LIMIT : 0;
  const balanceLamports = await withSponsorRpc(network, (connection) =>
    connection.getBalance(sponsor.publicKey),
  );

  return {
    enabled: limit > 0,
    sponsorAddress: sponsor.publicKey.toBase58(),
    balanceLamports,
    freeLimit: limit,
    freeUsed: used,
    freeRemaining: Math.max(0, limit - used),
    network: resolveNetwork(network),
  };
}

export async function sponsorPqcWalletInit(input: SponsorPqcInitInput) {
  const walletId = parseHex32(input.walletIdHex, "walletIdHex");
  const currentRoot = parseHex32(input.currentRootHex, "currentRootHex");
  const store = readStore();
  const existingRecord = store.records[input.walletIdHex!.toLowerCase()];
  if (existingRecord) {
    return { alreadySponsored: true, ...existingRecord };
  }

  const used = Object.keys(store.records).length;
  if (!Number.isFinite(FREE_SPONSOR_LIMIT) || FREE_SPONSOR_LIMIT <= 0 || used >= FREE_SPONSOR_LIMIT) {
    throw new Error("PQC sponsor quota is exhausted. Use self-funded initialization.");
  }

  const sponsor = readSponsorKeypair();
  const network = resolveNetwork(input.network);
  const programId = getProgramId();
  const [walletPda, bump] = findPqcWalletPda(walletId, programId);
  const signature = await withSponsorRpc(network, async (connection) => {
    const existingAccount = await connection.getAccountInfo(walletPda);
    if (existingAccount) {
      throw new Error("PQC wallet account already exists.");
    }

    const rentLamports = await connection.getMinimumBalanceForRentExemption(PQC_WALLET_SPACE);
    const balanceLamports = await connection.getBalance(sponsor.publicKey);
    if (balanceLamports < rentLamports + 10_000) {
      throw new Error(
        `PQC sponsor needs funding. Send SOL to ${sponsor.publicKey.toBase58()} and retry.`,
      );
    }

    const tx = new Transaction().add(
      createInitPqcWalletInstruction(sponsor.publicKey, walletPda, walletId, currentRoot, bump),
    );
    tx.feePayer = sponsor.publicKey;
    const latest = await connection.getLatestBlockhash();
    tx.recentBlockhash = latest.blockhash;
    tx.sign(sponsor);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    return signature;
  });

  const record: SponsoredWalletRecord = {
    walletIdHex: input.walletIdHex!.toLowerCase(),
    walletAddress: walletPda.toBase58(),
    signature,
    network,
    sponsoredAt: Date.now(),
  };
  store.records[record.walletIdHex] = record;
  writeStore(store);

  return {
    alreadySponsored: false,
    sponsorAddress: sponsor.publicKey.toBase58(),
    ...record,
  };
}
