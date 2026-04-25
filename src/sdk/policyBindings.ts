import type { PolicyProfile } from "@/types";

export interface WalletPolicyActionPayload {
  profileId: string | null;
  profileName: string | null;
  actionType: "send" | "admin";
  recipient: string;
  amount: number;
  token: string;
  notes: string;
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
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
  };
}

export async function buildWalletPolicyActionHash(
  payload: WalletPolicyActionPayload
): Promise<Uint8Array> {
  return sha256Json({
    kind: "vaulkyrie-wallet-policy-action-v1",
    ...payload,
  });
}

export async function buildWalletPolicyInputCommitment(params: {
  policyProfile: PolicyProfile | null;
  actionPayload: WalletPolicyActionPayload;
}): Promise<Uint8Array> {
  return sha256Json({
    kind: "vaulkyrie-wallet-policy-input-v1",
    profile: params.policyProfile,
    action: params.actionPayload,
  });
}

export async function buildWalletPolicyResultCommitment(params: {
  mode: "allow" | "review";
  reasonCode: number;
  actionHash: Uint8Array;
  computationOffset: bigint;
}): Promise<Uint8Array> {
  return sha256Json({
    kind: "vaulkyrie-wallet-policy-result-v1",
    mode: params.mode,
    reasonCode: params.reasonCode,
    actionHashHex: bytesToHex(params.actionHash),
    computationOffset: params.computationOffset.toString(),
  });
}
