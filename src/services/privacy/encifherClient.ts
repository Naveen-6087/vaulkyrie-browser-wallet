import { resolveRelayUrl } from "@/services/relay/relayAdapter";

export interface EncifherToken {
  symbol: string;
  tokenMintAddress: string;
  decimals: number;
}

export interface EncifherStatus {
  enabled: boolean;
  mode: "Mainnet" | "Devnet";
  supportedTokens: EncifherToken[];
  reason?: string;
}

export interface EncifherQuote {
  inMint: string;
  outMint: string;
  amountIn: string;
  amountOut: string;
  slippage: number;
  router: string;
  prioritizationFeeLamports: number;
}

export interface EncifherOrderDetails {
  inMint: string;
  outMint: string;
  amountIn: string;
  senderPubkey: string;
  receiverPubkey: string;
  message?: string;
}

export interface EncifherPreparedTransaction {
  transaction: string;
  transactionKind: "legacy";
}

export interface EncifherPreparedSwap extends EncifherPreparedTransaction {
  orderDetails: EncifherOrderDetails;
}

export interface EncifherExecuteResult {
  txHash: string;
  status: boolean;
  orderStatusIdentifier: {
    userPubKey: string;
    receiverEncryptedKey: string;
  };
}

function derivePrivacyBaseUrl(relayUrl: string): string {
  const resolved = resolveRelayUrl(relayUrl);
  const parsed = new URL(resolved);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = parsed.pathname === "/relay" ? "" : parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const json = (text ? JSON.parse(text) : {}) as { status?: string; error?: string } & T;
  if (!response.ok || json.status === "error") {
    throw new Error(json.error ?? (text.trim() || `Encifher request failed with ${response.status}`));
  }
  return json as T;
}

async function postJson<T>(relayUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${derivePrivacyBaseUrl(relayUrl)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonResponse<T>(response);
}

export async function fetchEncifherStatus(relayUrl: string): Promise<EncifherStatus> {
  const response = await fetch(`${derivePrivacyBaseUrl(relayUrl)}/privacy/encifher/status`);
  const json = await readJsonResponse<{ encifher: EncifherStatus }>(response);
  return json.encifher;
}

export async function fetchEncifherQuote(params: {
  relayUrl: string;
  inMint: string;
  outMint: string;
  amountIn: string;
}): Promise<EncifherQuote> {
  const json = await postJson<{ quote: EncifherQuote }>(params.relayUrl, "/privacy/encifher/quote", {
    inMint: params.inMint,
    outMint: params.outMint,
    amountIn: params.amountIn,
  });
  return json.quote;
}

export async function prepareEncifherDepositTx(params: {
  relayUrl: string;
  depositor: string;
  tokenSymbol: string;
  amount: string;
}): Promise<EncifherPreparedTransaction> {
  return postJson<EncifherPreparedTransaction>(params.relayUrl, "/privacy/encifher/deposit-tx", {
    depositor: params.depositor,
    tokenSymbol: params.tokenSymbol,
    amount: params.amount,
  });
}

export async function prepareEncifherWithdrawTx(params: {
  relayUrl: string;
  withdrawer: string;
  receiver?: string;
  tokenSymbol: string;
  amount: string;
}): Promise<EncifherPreparedTransaction> {
  return postJson<EncifherPreparedTransaction>(params.relayUrl, "/privacy/encifher/withdraw-tx", {
    withdrawer: params.withdrawer,
    receiver: params.receiver,
    tokenSymbol: params.tokenSymbol,
    amount: params.amount,
  });
}

export async function prepareEncifherSwapTx(params: {
  relayUrl: string;
  inMint: string;
  outMint: string;
  amountIn: string;
  senderPubkey: string;
  receiverPubkey: string;
  message?: string;
}): Promise<EncifherPreparedSwap> {
  return postJson<EncifherPreparedSwap>(params.relayUrl, "/privacy/encifher/swap-tx", {
    inMint: params.inMint,
    outMint: params.outMint,
    amountIn: params.amountIn,
    senderPubkey: params.senderPubkey,
    receiverPubkey: params.receiverPubkey,
    message: params.message,
  });
}

export async function executeEncifherSwap(params: {
  relayUrl: string;
  signedTransactionBase64: string;
  orderDetails: EncifherOrderDetails;
}): Promise<EncifherExecuteResult> {
  const json = await postJson<{ result: EncifherExecuteResult }>(params.relayUrl, "/privacy/encifher/execute-swap", {
    serializedTxn: params.signedTransactionBase64,
    orderDetails: params.orderDetails,
  });
  return json.result;
}

export async function fetchEncifherOrderStatus(params: {
  relayUrl: string;
  orderStatusIdentifier: EncifherExecuteResult["orderStatusIdentifier"];
}): Promise<string> {
  const json = await postJson<{ order: { status: string } }>(params.relayUrl, "/privacy/encifher/order-status", {
    orderStatusIdentifier: params.orderStatusIdentifier,
  });
  return json.order.status;
}
