/**
 * Solana RPC service — real connection to devnet/mainnet.
 * Fetches SOL balance, SPL token accounts, transaction history,
 * and Vaulkyrie program accounts via the SDK client.
 */
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  type ParsedTransactionWithMeta,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import { NETWORKS, type NetworkId } from "@/lib/constants";
import { VaulkyrieClient } from "@/sdk/client";
import type { Token, Transaction } from "@/types";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

const KNOWN_MINTS: Record<string, { symbol: string; name: string; decimals: number }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin", decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD", decimals: 6 },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: "JitoSOL", name: "Jito Staked SOL", decimals: 9 },
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: { symbol: "JTO", name: "Jito", decimals: 9 },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: "mSOL", name: "Marinade Staked SOL", decimals: 9 },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk", decimals: 5 },
};

export function createConnection(network: NetworkId): Connection {
  return new Connection(NETWORKS[network].rpcUrl, "confirmed");
}

export function createVaulkyrieClient(network: NetworkId): VaulkyrieClient {
  return new VaulkyrieClient(createConnection(network));
}

export async function fetchSolBalance(
  connection: Connection,
  publicKey: PublicKey
): Promise<number> {
  return connection.getBalance(publicKey);
}

export async function fetchTokenBalances(
  connection: Connection,
  publicKey: PublicKey
): Promise<Token[]> {
  const tokens: Token[] = [];

  const solBalance = await connection.getBalance(publicKey);
  tokens.push({
    symbol: "SOL",
    name: "Solana",
    balance: solBalance / LAMPORTS_PER_SOL,
    decimals: 9,
    usdValue: 0,
    change24h: 0,
  });

  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      publicKey,
      { programId: TOKEN_PROGRAM_ID }
    );

    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed?.info;
      if (!parsed) continue;

      const mint: string = parsed.mint;
      const amount: number = parsed.tokenAmount?.uiAmount ?? 0;
      if (amount === 0) continue;

      const known = KNOWN_MINTS[mint];
      tokens.push({
        symbol: known?.symbol ?? mint.slice(0, 4).toUpperCase(),
        name: known?.name ?? `Token ${mint.slice(0, 8)}…`,
        mint,
        balance: amount,
        decimals: parsed.tokenAmount?.decimals ?? 0,
        usdValue: 0,
        change24h: 0,
      });
    }
  } catch (err) {
    console.warn("Failed to fetch SPL tokens:", err);
  }

  return tokens;
}

export async function fetchTransactionHistory(
  connection: Connection,
  publicKey: PublicKey,
  limit = 20
): Promise<Transaction[]> {
  const transactions: Transaction[] = [];

  try {
    const signatures: ConfirmedSignatureInfo[] =
      await connection.getSignaturesForAddress(publicKey, { limit });

    const batchSize = 5;
    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);
      const txResults = await Promise.all(
        batch.map((sig) =>
          connection
            .getParsedTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
            })
            .catch(() => null)
        )
      );

      for (let j = 0; j < batch.length; j++) {
        const parsed = parseTransaction(txResults[j], publicKey, batch[j]);
        if (parsed) transactions.push(parsed);
      }
    }
  } catch (err) {
    console.warn("Failed to fetch transaction history:", err);
  }

  return transactions;
}

function parseTransaction(
  tx: ParsedTransactionWithMeta | null,
  wallet: PublicKey,
  sig: ConfirmedSignatureInfo
): Transaction | null {
  const walletStr = wallet.toBase58();
  let type: Transaction["type"] = "send";
  let amount = 0;
  let to: string | undefined;
  let from: string | undefined;

  if (tx?.meta) {
    const { preBalances, postBalances } = tx.meta;
    const accounts = tx.transaction.message.accountKeys;
    const walletIdx = accounts.findIndex(
      (ak) => ak.pubkey.toBase58() === walletStr
    );

    if (walletIdx >= 0 && preBalances && postBalances) {
      const diff = postBalances[walletIdx] - preBalances[walletIdx];
      if (diff > 0) {
        type = "receive";
        amount = diff;
        from =
          accounts[0].pubkey.toBase58() !== walletStr
            ? accounts[0].pubkey.toBase58()
            : undefined;
      } else {
        type = "send";
        amount = Math.abs(diff);
        to = accounts.length > 1 ? accounts[1].pubkey.toBase58() : undefined;
      }
    }
  }

  return {
    signature: sig.signature,
    type,
    amount,
    to,
    from,
    timestamp: (sig.blockTime ?? 0) * 1000,
    status:
      sig.confirmationStatus === "finalized" ||
      sig.confirmationStatus === "confirmed"
        ? "confirmed"
        : "pending",
    fee: tx?.meta?.fee,
  };
}

/**
 * Fetch token prices from CoinGecko free API.
 * Returns symbol → { usdPrice, change24h }.
 */
export async function fetchTokenPrices(
  symbols: string[]
): Promise<Record<string, { usd: number; change24h: number }>> {
  const prices: Record<string, { usd: number; change24h: number }> = {};

  const cgIds: Record<string, string> = {
    SOL: "solana",
    USDC: "usd-coin",
    USDT: "tether",
    JTO: "jito-governance-token",
    BONK: "bonk",
    mSOL: "msol",
    JitoSOL: "jito-staked-sol",
  };

  const ids = symbols
    .map((s) => cgIds[s])
    .filter(Boolean)
    .join(",");

  if (!ids) return prices;

  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`
    );
    if (!resp.ok) return prices;
    const data = await resp.json();

    for (const [symbol, cgId] of Object.entries(cgIds)) {
      if (data[cgId]) {
        prices[symbol] = {
          usd: data[cgId].usd ?? 0,
          change24h: data[cgId].usd_24h_change ?? 0,
        };
      }
    }
  } catch {
    // prices are optional — fail silently
  }

  return prices;
}
