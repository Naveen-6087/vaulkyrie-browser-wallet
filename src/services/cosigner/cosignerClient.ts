import { resolveRelayUrl } from "@/services/relay/relayAdapter";
import type { RelaySessionMetadata } from "@/services/relay/sessionInvite";

export interface VaultCosignerMetadata {
  enabled: boolean;
  vaultId: string;
  participantId: number;
  label: string;
  registeredAt: number;
  relayUrl: string;
}

export interface RegisterCosignerShareInput {
  vaultId: string;
  groupPublicKeyHex: string;
  publicKeyPackage: string;
  keyPackage: string;
  participantId: number;
  label?: string;
  relayUrl: string;
}

export interface RequestCosignerSignatureInput {
  cosigner: VaultCosignerMetadata | null | undefined;
  relayUrl: string;
  session: RelaySessionMetadata;
}

function deriveCosignerBaseUrl(relayUrl: string): string {
  const resolved = resolveRelayUrl(relayUrl);
  const parsed = new URL(resolved);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = parsed.pathname === "/relay" ? "" : parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function cosignerHeaders(): HeadersInit {
  const token = import.meta.env.VITE_COSIGNER_ADMIN_TOKEN?.trim();
  return {
    "Content-Type": "application/json",
    ...(token ? { "X-Cosigner-Token": token } : {}),
  };
}

async function postCosignerJson<T>(relayUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${deriveCosignerBaseUrl(relayUrl)}${path}`, {
    method: "POST",
    headers: cosignerHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text.trim() || `Cosigner request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function registerCosignerShare(
  input: RegisterCosignerShareInput,
): Promise<VaultCosignerMetadata> {
  const label = input.label?.trim() || "Vaulkyrie Server Cosigner";
  await postCosignerJson(input.relayUrl, "/cosigner/register", {
    vaultId: input.vaultId,
    groupPublicKeyHex: input.groupPublicKeyHex,
    publicKeyPackage: input.publicKeyPackage,
    keyPackage: input.keyPackage,
    participantId: input.participantId,
    label,
  });

  return {
    enabled: true,
    vaultId: input.vaultId,
    participantId: input.participantId,
    label,
    registeredAt: Date.now(),
    relayUrl: resolveRelayUrl(input.relayUrl),
  };
}

export async function requestCosignerSignature({
  cosigner,
  relayUrl,
  session,
}: RequestCosignerSignatureInput): Promise<boolean> {
  if (!cosigner?.enabled) {
    return false;
  }

  await postCosignerJson(relayUrl, "/cosigner/sign", {
    vaultId: cosigner.vaultId,
    relayUrl: resolveRelayUrl(session.relayUrl ?? relayUrl),
    sessionInvite: session.invite,
  });

  return true;
}

