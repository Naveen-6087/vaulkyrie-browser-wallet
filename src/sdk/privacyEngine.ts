import type {
  PrivacyActionId,
  PrivacyAssetSymbol,
  PrivacyProviderId,
  PrivacyReceiptRecord,
} from "@/types";

export type PrivacyAmountBucketId = "dust" | "small" | "medium" | "large" | "whale";
export type PrivacyPoolBucketId = "thin" | "building" | "healthy" | "deep";
export type PrivacyRouteRiskId = "low" | "medium" | "high" | "blocked";
export type PrivacyDisclosureModeId = "none" | "userReceipt" | "selectiveAudit" | "businessAudit";

export interface WalletPrivacySignals {
  action: PrivacyActionId;
  asset: PrivacyAssetSymbol;
  amountBucket: PrivacyAmountBucketId;
  poolBucket: PrivacyPoolBucketId;
  routeRisk: PrivacyRouteRiskId;
  disclosureMode: PrivacyDisclosureModeId;
  provider: PrivacyProviderId;
  flags: number;
}

export interface WalletPrivacyIntent {
  privacyAccountId: string;
  action: PrivacyActionId;
  asset: PrivacyAssetSymbol;
  amount: number;
  counterpartyCommitment: string;
  provider: PrivacyProviderId;
  nonce: bigint;
  expirySlot: bigint;
  flags: number;
}

export interface WalletPrivacyDecision {
  approved: boolean;
  provider: PrivacyProviderId;
  decisionFlags: number;
  privacyScore: number;
  minConfirmations: number;
}

export interface PrivacyArtifacts {
  intentCommitment: string;
  signalCommitment: string;
  requestCommitment: string;
  receiptCommitment: string;
  packedSignalLanes: [string, string];
  decision: WalletPrivacyDecision;
}

const ACTION_CODE: Record<PrivacyActionId, number> = {
  deposit: 1,
  transfer: 2,
  withdraw: 3,
  swapIntent: 4,
  sealReceipt: 5,
};

const ASSET_CODE: Record<PrivacyAssetSymbol, number> = {
  SOL: 1,
  USDC: 2,
};

const PROVIDER_CODE: Record<PrivacyProviderId, number> = {
  nativeArcium: 1,
  houdini: 2,
  encifher: 3,
  umbra: 4,
};

const AMOUNT_BUCKET_CODE: Record<PrivacyAmountBucketId, number> = {
  dust: 0,
  small: 1,
  medium: 2,
  large: 3,
  whale: 4,
};

const POOL_BUCKET_CODE: Record<PrivacyPoolBucketId, number> = {
  thin: 0,
  building: 1,
  healthy: 2,
  deep: 3,
};

const ROUTE_RISK_CODE: Record<PrivacyRouteRiskId, number> = {
  low: 0,
  medium: 1,
  high: 2,
  blocked: 3,
};

const DISCLOSURE_CODE: Record<PrivacyDisclosureModeId, number> = {
  none: 0,
  userReceipt: 1,
  selectiveAudit: 2,
  businessAudit: 3,
};

export const PRIVACY_FLAG_STEALTH_RECIPIENT = 1 << 0;
export const PRIVACY_FLAG_ONE_TIME_ADDRESS = 1 << 1;
export const PRIVACY_FLAG_SELECTIVE_DISCLOSURE = 1 << 2;
export const PRIVACY_FLAG_PROVIDER_ROUTE = 1 << 3;
export const PRIVACY_FLAG_NATIVE_SHIELDED = 1 << 4;
export const PRIVACY_FLAG_SWAP_INTENT = 1 << 5;
export const PRIVACY_FLAG_WITHDRAW_LINKABLE = 1 << 6;
export const PRIVACY_FLAG_SPONSORED_FEES = 1 << 7;

export const PRIVACY_DECISION_READY = 1 << 0;
export const PRIVACY_DECISION_NEEDS_SHIELDING = 1 << 1;
export const PRIVACY_DECISION_LINKABILITY_WARNING = 1 << 2;
export const PRIVACY_DECISION_ROUTE_PROVIDER = 1 << 3;
export const PRIVACY_DECISION_ROUTE_NATIVE = 1 << 4;
export const PRIVACY_DECISION_DISCLOSURE_AVAILABLE = 1 << 5;
export const PRIVACY_DECISION_BLOCKED = 1 << 6;

const PRIVACY_DOMAIN_INTENT = "VAULKYRIE_PRIVACY_INTENT_V1";
const PRIVACY_DOMAIN_SIGNALS = "VAULKYRIE_PRIVACY_SIGNALS_V1";
const PRIVACY_DOMAIN_RECEIPT = "VAULKYRIE_PRIVACY_RECEIPT_V1";
const PRIVACY_DOMAIN_ACCOUNT = "VAULKYRIE_PRIVACY_ACCOUNT_V1";

const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string, length = 32): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(length);
  for (let i = 0; i < Math.min(length, Math.floor(clean.length / 2)); i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function u64Le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function u16Le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

function u128Le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(16);
  let v = value;
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256(parts: Array<string | Uint8Array>): Promise<string> {
  const bytes = concatBytes(parts.map((part) => typeof part === "string" ? textEncoder.encode(part) : part));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function amountAtoms(amount: number, asset: PrivacyAssetSymbol): bigint {
  const decimals = asset === "SOL" ? 9 : 6;
  return BigInt(Math.max(0, Math.round(amount * 10 ** decimals)));
}

export function bucketPrivacyAmount(amount: number, asset: PrivacyAssetSymbol): PrivacyAmountBucketId {
  const normalizedUsd = asset === "SOL" ? amount * 150 : amount;
  if (normalizedUsd < 1) return "dust";
  if (normalizedUsd < 100) return "small";
  if (normalizedUsd < 1_000) return "medium";
  if (normalizedUsd < 10_000) return "large";
  return "whale";
}

export function packPrivacySignals(signals: WalletPrivacySignals): [bigint, bigint] {
  const lane0 =
    BigInt(ACTION_CODE[signals.action]) |
    (BigInt(ASSET_CODE[signals.asset]) << 8n) |
    (BigInt(AMOUNT_BUCKET_CODE[signals.amountBucket]) << 16n) |
    (BigInt(POOL_BUCKET_CODE[signals.poolBucket]) << 24n) |
    (BigInt(ROUTE_RISK_CODE[signals.routeRisk]) << 32n) |
    (BigInt(DISCLOSURE_CODE[signals.disclosureMode]) << 40n) |
    (BigInt(PROVIDER_CODE[signals.provider]) << 48n) |
    (BigInt(signals.flags & 0xffff) << 56n);

  return [lane0, 0n];
}

export async function privacySignalsCommitment(signals: WalletPrivacySignals): Promise<string> {
  const lanes = packPrivacySignals(signals);
  return sha256([
    PRIVACY_DOMAIN_SIGNALS,
    u128Le(lanes[0]),
    u128Le(lanes[1]),
  ]);
}

export async function privacyIntentCommitment(intent: WalletPrivacyIntent): Promise<string> {
  return sha256([
    PRIVACY_DOMAIN_INTENT,
    hexToBytes(intent.privacyAccountId),
    new Uint8Array([ACTION_CODE[intent.action], ASSET_CODE[intent.asset]]),
    u64Le(amountAtoms(intent.amount, intent.asset)),
    hexToBytes(intent.counterpartyCommitment),
    new Uint8Array([PROVIDER_CODE[intent.provider]]),
    u64Le(intent.nonce),
    u64Le(intent.expirySlot),
    u16Le(intent.flags),
  ]);
}

export function evaluatePrivacy(signals: WalletPrivacySignals): WalletPrivacyDecision {
  let score = 35;
  let flags = 0;

  score += ({ dust: 6, small: 10, medium: 14, large: 18, whale: 22 } as const)[signals.amountBucket];
  score += ({ thin: 2, building: 9, healthy: 17, deep: 24 } as const)[signals.poolBucket];

  if (signals.poolBucket === "thin") flags |= PRIVACY_DECISION_LINKABILITY_WARNING;

  if (signals.routeRisk === "low") score += 12;
  if (signals.routeRisk === "medium") score += 4;
  if (signals.routeRisk === "high") {
    score -= 10;
    flags |= PRIVACY_DECISION_LINKABILITY_WARNING;
  }
  if (signals.routeRisk === "blocked") {
    flags |= PRIVACY_DECISION_BLOCKED;
  }

  if (signals.routeRisk !== "blocked") {
    if (signals.flags & PRIVACY_FLAG_STEALTH_RECIPIENT) score += 8;
    if (signals.flags & PRIVACY_FLAG_ONE_TIME_ADDRESS) score += 8;
    if (signals.flags & PRIVACY_FLAG_WITHDRAW_LINKABLE) {
      score -= 20;
      flags |= PRIVACY_DECISION_LINKABILITY_WARNING;
    }
  }
  if (signals.disclosureMode !== "none") flags |= PRIVACY_DECISION_DISCLOSURE_AVAILABLE;
  flags |= signals.provider === "nativeArcium" ? PRIVACY_DECISION_ROUTE_NATIVE : PRIVACY_DECISION_ROUTE_PROVIDER;
  if (signals.action === "transfer" || signals.action === "swapIntent") flags |= PRIVACY_DECISION_NEEDS_SHIELDING;

  const approved = signals.routeRisk !== "blocked";
  if (approved) flags |= PRIVACY_DECISION_READY;

  return {
    approved,
    provider: signals.provider,
    decisionFlags: flags,
    privacyScore: approved ? Math.max(0, Math.min(100, score)) : 0,
    minConfirmations: ({ thin: 8, building: 4, healthy: 2, deep: 1 } as const)[signals.poolBucket],
  };
}

export async function buildPrivacyArtifacts(
  intent: WalletPrivacyIntent,
  signals: WalletPrivacySignals,
  requestNonce: bigint,
): Promise<PrivacyArtifacts> {
  const packed = packPrivacySignals(signals);
  const intentCommitment = await privacyIntentCommitment(intent);
  const signalCommitment = await privacySignalsCommitment(signals);
  const requestCommitment = await sha256([
    intentCommitment,
    signalCommitment,
    u64Le(requestNonce),
    u64Le(intent.expirySlot),
  ]);
  const decision = evaluatePrivacy(signals);
  const receiptCommitment = await sha256([
    PRIVACY_DOMAIN_RECEIPT,
    requestCommitment,
    new Uint8Array([decision.approved ? 1 : 0, PROVIDER_CODE[decision.provider]]),
    u16Le(decision.decisionFlags),
    new Uint8Array([decision.privacyScore, decision.minConfirmations]),
    u64Le(0n),
  ]);

  return {
    intentCommitment,
    signalCommitment,
    requestCommitment,
    receiptCommitment,
    packedSignalLanes: [packed[0].toString(), packed[1].toString()],
    decision,
  };
}

export async function derivePrivacyAccountMaterial(ownerPublicKey: string, label: string, createdAt: number) {
  const seed = await sha256([PRIVACY_DOMAIN_ACCOUNT, ownerPublicKey, label, String(createdAt)]);
  const accountId = await sha256([seed, "account"]);
  const scanPublicKey = await sha256([seed, "scan"]);
  const spendPublicKeyCommitment = await sha256([seed, "spend"]);
  const viewingKeyCommitment = await sha256([seed, "view"]);
  const receiveRaw = concatBytes([
    textEncoder.encode("vpriv1:"),
    hexToBytes(accountId, 18),
    hexToBytes(scanPublicKey, 18),
  ]);

  return {
    id: accountId,
    receiveCode: `vpriv1:${base64Url(receiveRaw).slice(0, 48)}`,
    scanPublicKey,
    spendPublicKeyCommitment,
    viewingKeyCommitment,
  };
}

export async function counterpartyCommitment(value: string): Promise<string> {
  return sha256(["VAULKYRIE_PRIVACY_COUNTERPARTY_V1", value || "self"]);
}

export async function createPrivacyReceipt(params: {
  accountId: string;
  ownerPublicKey: string;
  network: PrivacyReceiptRecord["network"];
  action: PrivacyActionId;
  asset: PrivacyAssetSymbol;
  amount: number;
  provider: PrivacyProviderId;
  recipientHint?: string | null;
  disclosureMode: PrivacyDisclosureModeId;
  poolBucket: PrivacyPoolBucketId;
  routeRisk: PrivacyRouteRiskId;
  flags: number;
}): Promise<PrivacyReceiptRecord> {
  const now = Date.now();
  const counterparty = await counterpartyCommitment(params.recipientHint ?? params.ownerPublicKey);
  const nonce = BigInt(now);
  const intent: WalletPrivacyIntent = {
    privacyAccountId: params.accountId,
    action: params.action,
    asset: params.asset,
    amount: params.amount,
    counterpartyCommitment: counterparty,
    provider: params.provider,
    nonce,
    expirySlot: BigInt(Math.floor(now / 1000) + 60 * 30),
    flags: params.flags,
  };
  const signals: WalletPrivacySignals = {
    action: params.action,
    asset: params.asset,
    amountBucket: bucketPrivacyAmount(params.amount, params.asset),
    poolBucket: params.poolBucket,
    routeRisk: params.routeRisk,
    disclosureMode: params.disclosureMode,
    provider: params.provider,
    flags: params.flags,
  };
  const artifacts = await buildPrivacyArtifacts(intent, signals, nonce);

  return {
    id: artifacts.receiptCommitment,
    accountId: params.accountId,
    ownerPublicKey: params.ownerPublicKey,
    network: params.network,
    action: params.action,
    asset: params.asset,
    amount: params.amount,
    provider: params.provider,
    recipientHint: params.recipientHint ?? null,
    intentCommitment: artifacts.intentCommitment,
    signalCommitment: artifacts.signalCommitment,
    requestCommitment: artifacts.requestCommitment,
    receiptCommitment: artifacts.receiptCommitment,
    packedSignalLanes: artifacts.packedSignalLanes,
    privacyScore: artifacts.decision.privacyScore,
    minConfirmations: artifacts.decision.minConfirmations,
    decisionFlags: artifacts.decision.decisionFlags,
    status: artifacts.decision.approved ? "sealed" : "failed",
    disclosureMode: params.disclosureMode,
    createdAt: now,
  };
}
