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

export const KNOWN_MINTS: Record<string, { symbol: string; name: string; decimals: number; icon: string }> = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", name: "USD Coin", decimals: 6, icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png" },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", name: "Tether USD", decimals: 6, icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png" },
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": { symbol: "JitoSOL", name: "Jito Staked SOL", decimals: 9, icon: "https://storage.googleapis.com/token-metadata/JitoSOL-256.png" },
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL": { symbol: "JTO", name: "Jito", decimals: 9, icon: "https://metadata.jito.network/token/jto/icon" },
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": { symbol: "mSOL", name: "Marinade Staked SOL", decimals: 9, icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So/logo.png" },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol: "BONK", name: "Bonk", decimals: 5, icon: "https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I" },
  "So11111111111111111111111111111111111111112": { symbol: "SOL", name: "Solana", decimals: 9, icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png" },
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": { symbol: "stSOL", name: "Lido Staked SOL", decimals: 9, icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj/logo.png" },
  "RLBxxFkseAZ4RgJH3Sqn8jXxhmGoz9jWxDNJMh8pL7a": { symbol: "RLBB", name: "Rollbit", decimals: 2, icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/RLBxxFkseAZ4RgJH3Sqn8jXxhmGoz9jWxDNJMh8pL7a/logo.png" },
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": { symbol: "JUP", name: "Jupiter", decimals: 6, icon: "https://static.jup.ag/jup/icon.png" },
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": { symbol: "WETH", name: "Wrapped Ether (Wormhole)", decimals: 8, icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs/logo.png" },
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof": { symbol: "RENDER", name: "Render Token", decimals: 8, icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof/logo.png" },
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3": { symbol: "PYTH", name: "Pyth Network", decimals: 6, icon: "https://pyth.network/token.png" },
  "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux": { symbol: "HNT", name: "Helium", decimals: 8, icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux/logo.png" },
  "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p91oHk": { symbol: "WEN", name: "Wen", decimals: 5, icon: "https://shdw-drive.genesysgo.net/GwJapVHVvfM4Mw4sWszkzywncUWuxxPd6s9VuUd3PNG/wen.png" },
};

export const SOL_ICON = KNOWN_MINTS["So11111111111111111111111111111111111111112"].icon;

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
    icon: SOL_ICON,
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
        icon: known?.icon,
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
  let token: string | undefined;

  if (tx?.meta) {
    const { preBalances, postBalances } = tx.meta;
    const accounts = tx.transaction.message.accountKeys;
    const walletIdx = accounts.findIndex(
      (ak) => ak.pubkey.toBase58() === walletStr
    );

    // Check for SPL token transfers first
    const splTransfer = parseSplTokenTransfer(tx, walletStr);
    if (splTransfer) {
      type = splTransfer.type;
      amount = splTransfer.amount;
      to = splTransfer.to;
      from = splTransfer.from;
      token = splTransfer.token;
    } else if (walletIdx >= 0 && preBalances && postBalances) {
      // Native SOL transfer
      const diff = postBalances[walletIdx] - preBalances[walletIdx];
      const fee = tx.meta.fee ?? 0;
      // If SOL change is just the fee, it's likely a token/program tx, not a SOL transfer
      if (Math.abs(diff + fee) < 1000) {
        // SOL only decreased by fee — skip as this is not a meaningful SOL transfer
        return null;
      }

      if (diff > 0) {
        type = "receive";
        amount = diff;
        from =
          accounts[0].pubkey.toBase58() !== walletStr
            ? accounts[0].pubkey.toBase58()
            : undefined;
      } else {
        type = "send";
        // Subtract fee from the amount so we show the actual SOL transferred
        amount = Math.abs(diff) - fee;
        if (amount <= 0) return null;
        to = accounts.length > 1 ? accounts[1].pubkey.toBase58() : undefined;
      }
      token = "SOL";
    }
  }

  if (amount <= 0 && !token) return null;

  return {
    signature: sig.signature,
    type,
    amount,
    token,
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

/** Parse SPL token transfer details from a transaction */
function parseSplTokenTransfer(
  tx: ParsedTransactionWithMeta,
  walletStr: string
): { type: "send" | "receive"; amount: number; to?: string; from?: string; token: string } | null {
  if (!tx.meta?.innerInstructions && !tx.transaction.message.instructions) return null;

  const TOKEN_PROGRAM = "TokenkegQceLL7JStPeAt6xBreCXoBy6gJgp7DW7nk";
  const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

  // Look through parsed instructions for transfer/transferChecked
  for (const ix of tx.transaction.message.instructions) {
    if (!("parsed" in ix)) continue;
    const parsed = ix as { program: string; programId: { toBase58(): string }; parsed: { type: string; info: Record<string, unknown> } };
    const programId = parsed.programId.toBase58();

    if (programId !== TOKEN_PROGRAM && programId !== TOKEN_2022) continue;
    if (parsed.parsed.type !== "transfer" && parsed.parsed.type !== "transferChecked") continue;

    const info = parsed.parsed.info;
    const authority = info.authority as string | undefined;
    const source = info.source as string | undefined;
    const destination = info.destination as string | undefined;

    // Determine if we sent or received
    const isSender = authority === walletStr || source === walletStr;

    // Find token mint and decimals from pre/post token balances
    let tokenSymbol = "SPL";
    let tokenDecimals = 0;
    if (tx.meta?.preTokenBalances) {
      for (const tb of tx.meta.preTokenBalances) {
        if (tb.owner === walletStr || tb.mint) {
          const known = tb.mint ? KNOWN_MINTS[tb.mint] : undefined;
          tokenSymbol = known?.symbol ?? tb.mint?.slice(0, 6) ?? "SPL";
          tokenDecimals = tb.uiTokenAmount?.decimals ?? known?.decimals ?? 0;
          break;
        }
      }
    }

    let transferAmount = 0;
    if (parsed.parsed.type === "transferChecked") {
      const tokenAmount = info.tokenAmount as { uiAmount?: number; amount?: string } | undefined;
      transferAmount = tokenAmount?.uiAmount ?? 0;
    } else {
      // Regular transfer: amount is in raw units, convert to UI amount
      const rawAmount = Number(info.amount ?? 0);
      transferAmount = tokenDecimals > 0 ? rawAmount / 10 ** tokenDecimals : rawAmount;
    }

    return {
      type: isSender ? "send" : "receive",
      amount: transferAmount,
      to: isSender ? (destination ?? undefined) : undefined,
      from: isSender ? undefined : (source ?? undefined),
      token: tokenSymbol,
    };
  }

  // Also check inner instructions for SPL transfers
  if (tx.meta?.innerInstructions) {
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        if (!("parsed" in ix)) continue;
        const parsed = ix as { program: string; programId: { toBase58(): string }; parsed: { type: string; info: Record<string, unknown> } };
        const programId = parsed.programId.toBase58();
        if (programId !== TOKEN_PROGRAM && programId !== TOKEN_2022) continue;
        if (parsed.parsed.type !== "transfer" && parsed.parsed.type !== "transferChecked") continue;

        const info = parsed.parsed.info;
        const authority = info.authority as string | undefined;
        const source = info.source as string | undefined;
        const destination = info.destination as string | undefined;

        const isSender = authority === walletStr || source === walletStr;

        // Find token decimals from pre/post token balances
        let innerTokenSymbol = "SPL";
        let innerTokenDecimals = 0;
        if (tx.meta?.preTokenBalances) {
          for (const tb of tx.meta.preTokenBalances) {
            if (tb.owner === walletStr || tb.mint) {
              const known = tb.mint ? KNOWN_MINTS[tb.mint] : undefined;
              innerTokenSymbol = known?.symbol ?? tb.mint?.slice(0, 6) ?? "SPL";
              innerTokenDecimals = tb.uiTokenAmount?.decimals ?? known?.decimals ?? 0;
              break;
            }
          }
        }

        let transferAmount = 0;
        if (parsed.parsed.type === "transferChecked") {
          const tokenAmount = info.tokenAmount as { uiAmount?: number } | undefined;
          transferAmount = tokenAmount?.uiAmount ?? 0;
        } else {
          const rawAmount = Number(info.amount ?? 0);
          transferAmount = innerTokenDecimals > 0 ? rawAmount / 10 ** innerTokenDecimals : rawAmount;
        }

        return {
          type: isSender ? "send" : "receive",
          amount: transferAmount,
          to: isSender ? (destination ?? undefined) : undefined,
          from: isSender ? undefined : (source ?? undefined),
          token: innerTokenSymbol,
        };
      }
    }
  }

  return null;
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
    stSOL: "lido-staked-sol",
    JUP: "jupiter-exchange-solana",
    WETH: "ethereum",
    RENDER: "render-token",
    PYTH: "pyth-network",
    HNT: "helium",
    WEN: "wen-4",
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
