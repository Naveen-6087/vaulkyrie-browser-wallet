import type { PolicyProfile } from "@/types";
import {
  buildPolicyResultCommitment,
  deriveWalletPolicySignals,
  evaluateWalletPolicy,
  packWalletPolicySignalLanes,
  policySignalCommitment,
} from "./policyEngine";

export interface WalletPolicyActionPayload {
  profileId: string | null;
  profileName: string | null;
  actionType: "send" | "admin";
  recipient: string;
  amount: number;
  token: string;
  notes: string;
  template: PolicyProfile["template"] | null;
  approvalMode: PolicyProfile["approvalMode"] | null;
  defaultProtocolRisk: PolicyProfile["defaultProtocolRisk"] | null;
  defaultDeviceTrust: PolicyProfile["defaultDeviceTrust"] | null;
  guardianPosture: PolicyProfile["guardianPosture"] | null;
  recipientMode: PolicyProfile["recipientMode"] | null;
  forcePqcReview: boolean;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function sha256Json(value: unknown): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(encoded));
  return new Uint8Array(digest);
}

export function buildWalletPolicyActionPayload(params: {
  profile: PolicyProfile | null;
  actionType: "send" | "admin";
  recipient: string;
  amount: number;
  token: string;
}): WalletPolicyActionPayload {
  return {
    profileId: params.profile?.id ?? null,
    profileName: params.profile?.name ?? null,
    actionType: params.actionType,
    recipient: params.recipient.trim(),
    amount: params.amount,
    token: params.token.trim().toUpperCase() || "SOL",
    notes: params.profile?.notes ?? "",
    template: params.profile?.template ?? null,
    approvalMode: params.profile?.approvalMode ?? null,
    defaultProtocolRisk: params.profile?.defaultProtocolRisk ?? null,
    defaultDeviceTrust: params.profile?.defaultDeviceTrust ?? null,
    guardianPosture: params.profile?.guardianPosture ?? null,
    recipientMode: params.profile?.recipientMode ?? null,
    forcePqcReview: params.profile?.forcePqcReview ?? false,
  };
}

export async function buildWalletPolicyActionHash(
  payload: WalletPolicyActionPayload
): Promise<Uint8Array> {
  return sha256Json({
    kind: "vaulkyrie-wallet-policy-action-v2",
    ...payload,
  });
}

export async function buildWalletPolicyEvaluationDraft(params: {
  policyProfile: PolicyProfile | null;
  actionPayload: WalletPolicyActionPayload;
  accountPublicKey?: string | null;
  tokenBalance?: number;
  totalBalance?: number;
  contacts?: ReadonlyArray<{ address: string }>;
  recentTransactions?: ReadonlyArray<{
    timestamp: number;
    status: "confirmed" | "pending" | "failed";
    type: string;
  }>;
  recoverySessions?: ReadonlyArray<{ status: string }>;
  cosignerEnabled?: boolean;
  cosignerAttested?: boolean;
  currentSlot?: bigint | number;
  expirySlot?: bigint | number;
}) {
  const signals = deriveWalletPolicySignals({
    policyProfile: params.policyProfile,
    actionType: params.actionPayload.actionType,
    recipient: params.actionPayload.recipient,
    amount: params.actionPayload.amount,
    tokenSymbol: params.actionPayload.token,
    accountPublicKey: params.accountPublicKey,
    tokenBalance: params.tokenBalance,
    totalBalance: params.totalBalance,
    contacts: params.contacts,
    recentTransactions: params.recentTransactions,
    recoverySessions: params.recoverySessions,
    cosignerEnabled: params.cosignerEnabled,
    cosignerAttested: params.cosignerAttested,
  });
  const signalCommitment = await policySignalCommitment(signals);
  const packedSignalLanes = packWalletPolicySignalLanes(signals);
  return {
    signals,
    signalCommitment,
    packedSignalLanes,
    preview:
      params.currentSlot !== undefined && params.expirySlot !== undefined
        ? evaluateWalletPolicy(signals, params.currentSlot, params.expirySlot)
        : null,
  };
}

export async function buildWalletPolicyInputCommitment(params: {
  policyProfile: PolicyProfile | null;
  actionPayload: WalletPolicyActionPayload;
  accountPublicKey?: string | null;
  tokenBalance?: number;
  totalBalance?: number;
  contacts?: ReadonlyArray<{ address: string }>;
  recentTransactions?: ReadonlyArray<{
    timestamp: number;
    status: "confirmed" | "pending" | "failed";
    type: string;
  }>;
  recoverySessions?: ReadonlyArray<{ status: string }>;
  cosignerEnabled?: boolean;
  cosignerAttested?: boolean;
}): Promise<Uint8Array> {
  const draft = await buildWalletPolicyEvaluationDraft(params);
  return draft.signalCommitment;
}

export async function buildWalletPolicyResultCommitment(params: {
  requestCommitment: Uint8Array;
  signalCommitment: Uint8Array;
  threshold: number;
  delayUntilSlot: bigint | number;
  approved: boolean;
  decisionFlags?: number;
  riskScore?: number;
  riskTier?: number | "low" | "medium" | "high" | "critical";
  reasonCode: number;
}): Promise<Uint8Array> {
  return buildPolicyResultCommitment({
    requestCommitment: params.requestCommitment,
    signalCommitment: params.signalCommitment,
    threshold: params.threshold,
    delayUntilSlot: params.delayUntilSlot,
    reasonCode: params.reasonCode,
    decisionFlags: params.decisionFlags ?? 0,
    riskScore: params.riskScore ?? 0,
    riskTier: params.riskTier ?? "low",
    approved: params.approved,
  });
}
