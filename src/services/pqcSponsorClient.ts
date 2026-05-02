import { resolveRelayUrl } from "@/services/relay/relayAdapter";
import type { NetworkId } from "@/lib/constants";

export interface PqcSponsorStatus {
  enabled: boolean;
  sponsorAddress: string;
  balanceLamports: number;
  freeLimit: number;
  freeUsed: number;
  freeRemaining: number;
  network: string;
}

export interface SponsoredPqcInitResult {
  alreadySponsored: boolean;
  sponsorAddress: string;
  walletIdHex: string;
  walletAddress: string;
  signature: string;
  network: string;
  sponsoredAt: number;
}

function deriveSponsorBaseUrl(relayUrl: string): string {
  const resolved = resolveRelayUrl(relayUrl);
  const parsed = new URL(resolved);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = parsed.pathname === "/relay" ? "" : parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function sponsorHeaders(): HeadersInit {
  const token = import.meta.env.VITE_PQC_SPONSOR_ADMIN_TOKEN?.trim();
  return {
    "Content-Type": "application/json",
    ...(token ? { "X-Sponsor-Token": token } : {}),
  };
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const json = (text ? JSON.parse(text) : {}) as { status?: string; error?: string } & T;
  if (!response.ok || json.status === "error") {
    throw new Error(json.error ?? (text.trim() || `PQC sponsor request failed with ${response.status}`));
  }
  return json as T;
}

export async function fetchPqcSponsorStatus(
  relayUrl: string,
  network: NetworkId,
): Promise<PqcSponsorStatus> {
  const url = new URL(`${deriveSponsorBaseUrl(relayUrl)}/pqc/sponsor/status`);
  url.searchParams.set("network", network);
  const response = await fetch(url);
  const json = await readJsonResponse<{ sponsor: PqcSponsorStatus }>(response);
  return json.sponsor;
}

export async function requestSponsoredPqcInit(params: {
  relayUrl: string;
  network: NetworkId;
  walletIdHex: string;
  currentRootHex: string;
}): Promise<SponsoredPqcInitResult> {
  const response = await fetch(`${deriveSponsorBaseUrl(params.relayUrl)}/pqc/sponsor/init`, {
    method: "POST",
    headers: sponsorHeaders(),
    body: JSON.stringify({
      network: params.network,
      walletIdHex: params.walletIdHex,
      currentRootHex: params.currentRootHex,
    }),
  });

  return readJsonResponse<SponsoredPqcInitResult>(response);
}
