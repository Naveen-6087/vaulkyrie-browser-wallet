import { PublicKey, Transaction } from "@solana/web3.js";
import {
  DefiClient,
  type DefiClientConfig,
  type ExecuteSwapResponse,
  type OrderStatusIdentifier,
  type QuoteResponse,
  type SwapParams,
  type Token,
} from "encifher-swap-sdk";

const MAINNET_USDC: Token = {
  tokenMintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
};

const MAINNET_USDT: Token = {
  tokenMintAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  decimals: 6,
};

const KNOWN_TOKENS: Record<string, Token> = {
  USDC: MAINNET_USDC,
  USDT: MAINNET_USDT,
  [MAINNET_USDC.tokenMintAddress]: MAINNET_USDC,
  [MAINNET_USDT.tokenMintAddress]: MAINNET_USDT,
};

export interface EncifherStatus {
  enabled: boolean;
  mode: "Mainnet" | "Devnet";
  supportedTokens: Array<Token & { symbol: string }>;
  reason?: string;
}

export interface EncifherQuoteInput {
  inMint?: string;
  outMint?: string;
  amountIn?: string;
}

export interface EncifherDepositInput {
  depositor?: string;
  mintAddress?: string;
  tokenSymbol?: string;
  amount?: string;
}

export interface EncifherWithdrawInput {
  withdrawer?: string;
  receiver?: string;
  mintAddress?: string;
  tokenSymbol?: string;
  amount?: string;
}

export interface EncifherSwapInput {
  inMint?: string;
  outMint?: string;
  amountIn?: string;
  senderPubkey?: string;
  receiverPubkey?: string;
  message?: string;
}

export interface EncifherExecuteSwapInput {
  serializedTxn?: string;
  orderDetails?: {
    inMint?: string;
    outMint?: string;
    amountIn?: string;
    senderPubkey?: string;
    receiverPubkey?: string;
    message?: string;
  };
}

export interface EncifherOrderStatusInput {
  orderStatusIdentifier?: OrderStatusIdentifier;
}

function getConfig(): DefiClientConfig {
  const encifherKey = process.env.ENCIFHER_SDK_KEY ?? process.env.SDK_KEY ?? "";
  const rpcUrl = process.env.ENCIFHER_RPC_URL ?? process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const mode = process.env.ENCIFHER_MODE === "Devnet" ? "Devnet" : "Mainnet";

  if (!encifherKey) {
    throw new Error("ENCIFHER_SDK_KEY is not configured on the relay server.");
  }

  return { encifherKey, rpcUrl, mode };
}

function getClient(): DefiClient {
  return new DefiClient(getConfig());
}

function serializeUnsignedTransaction(transaction: Transaction): string {
  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString("base64");
}

function parsePublicKey(value: unknown, field: string): PublicKey {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new Error(`${field} is not a valid Solana address.`);
  }
}

function parseAmount(value: unknown, field = "amount"): string {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim()) || BigInt(value.trim()) <= 0n) {
    throw new Error(`${field} must be a positive integer token amount in base units.`);
  }
  return value.trim();
}

function parseMint(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return parsePublicKey(value, field).toBase58();
}

function resolveToken(input: EncifherDepositInput | EncifherWithdrawInput): Token {
  const key = (input.tokenSymbol ?? input.mintAddress ?? "").trim();
  const token = KNOWN_TOKENS[key] ?? KNOWN_TOKENS[key.toUpperCase()];
  if (token) return token;

  const mint = parseMint(input.mintAddress, "mintAddress");
  const decimals = Number.parseInt(process.env.ENCIFHER_DEFAULT_DECIMALS ?? "6", 10);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("ENCIFHER_DEFAULT_DECIMALS must be between 0 and 18.");
  }
  return { tokenMintAddress: mint, decimals };
}

function parseSwapParams(input: EncifherSwapInput): SwapParams {
  return {
    inMint: parseMint(input.inMint, "inMint"),
    outMint: parseMint(input.outMint, "outMint"),
    amountIn: parseAmount(input.amountIn, "amountIn"),
    senderPubkey: parsePublicKey(input.senderPubkey, "senderPubkey"),
    receiverPubkey: parsePublicKey(input.receiverPubkey ?? input.senderPubkey, "receiverPubkey"),
    message: input.message,
  };
}

function parseOrderDetails(input: EncifherExecuteSwapInput["orderDetails"]): SwapParams {
  if (!input) {
    throw new Error("orderDetails is required.");
  }
  return parseSwapParams(input);
}

export function getEncifherStatus(): EncifherStatus {
  const mode = process.env.ENCIFHER_MODE === "Devnet" ? "Devnet" : "Mainnet";
  const enabled = Boolean(process.env.ENCIFHER_SDK_KEY ?? process.env.SDK_KEY);
  return {
    enabled,
    mode,
    supportedTokens: [
      { symbol: "USDC", ...MAINNET_USDC },
      { symbol: "USDT", ...MAINNET_USDT },
    ],
    reason: enabled ? undefined : "Set ENCIFHER_SDK_KEY on the relay server.",
  };
}

export async function getEncifherQuote(input: EncifherQuoteInput): Promise<QuoteResponse> {
  const client = getClient();
  return client.getSwapQuote({
    inMint: parseMint(input.inMint, "inMint"),
    outMint: parseMint(input.outMint, "outMint"),
    amountIn: parseAmount(input.amountIn, "amountIn"),
  });
}

export async function prepareEncifherDeposit(input: EncifherDepositInput) {
  const transaction = await getClient().getDepositTxn({
    token: resolveToken(input),
    depositor: parsePublicKey(input.depositor, "depositor"),
    amount: parseAmount(input.amount),
  });
  return {
    transaction: serializeUnsignedTransaction(transaction),
    transactionKind: "legacy" as const,
  };
}

export async function prepareEncifherWithdraw(input: EncifherWithdrawInput) {
  const withdrawer = parsePublicKey(input.withdrawer, "withdrawer");
  const transaction = await getClient().getWithdrawTxn({
    token: resolveToken(input),
    withdrawer,
    receiver: input.receiver ? parsePublicKey(input.receiver, "receiver") : withdrawer,
    amount: parseAmount(input.amount),
  });
  return {
    transaction: serializeUnsignedTransaction(transaction),
    transactionKind: "legacy" as const,
  };
}

export async function prepareEncifherSwap(input: EncifherSwapInput) {
  const orderDetails = parseSwapParams(input);
  const transaction = await getClient().getSwapTxn(orderDetails);
  return {
    transaction: serializeUnsignedTransaction(transaction),
    transactionKind: "legacy" as const,
    orderDetails: {
      ...orderDetails,
      senderPubkey: orderDetails.senderPubkey.toBase58(),
      receiverPubkey: orderDetails.receiverPubkey.toBase58(),
    },
  };
}

export async function executeEncifherSwap(input: EncifherExecuteSwapInput): Promise<ExecuteSwapResponse> {
  if (typeof input.serializedTxn !== "string" || !input.serializedTxn.trim()) {
    throw new Error("serializedTxn is required.");
  }

  return getClient().executeSwapTxn({
    serializedTxn: input.serializedTxn.trim(),
    orderDetails: parseOrderDetails(input.orderDetails),
  });
}

export async function getEncifherOrderStatus(input: EncifherOrderStatusInput) {
  if (!input.orderStatusIdentifier) {
    throw new Error("orderStatusIdentifier is required.");
  }
  return getClient().getOrderStatus({
    orderStatusIdentifier: input.orderStatusIdentifier,
  });
}
