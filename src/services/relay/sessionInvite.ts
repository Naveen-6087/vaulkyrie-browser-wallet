const SESSION_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_CODE_LENGTH = 6;
const SESSION_AUTH_LENGTH = 8;

const VERIFICATION_ADJECTIVES = [
  "amber",
  "apex",
  "aurora",
  "brisk",
  "cobalt",
  "ember",
  "frost",
  "glacier",
  "harbor",
  "lumen",
  "nova",
  "onyx",
  "quartz",
  "rapid",
  "silver",
  "vivid",
];

const VERIFICATION_NOUNS = [
  "anchor",
  "beacon",
  "circuit",
  "comet",
  "delta",
  "falcon",
  "harbor",
  "junction",
  "keystone",
  "lantern",
  "meadow",
  "orbit",
  "reef",
  "signal",
  "summit",
  "vector",
];

export interface RelaySessionMetadata {
  code: string;
  authToken: string | null;
  invite: string;
  verificationPhrase: string;
  expiresAt: number | null;
  relayUrl: string | null;
}

const SUPPORTED_INVITE_PROTOCOLS = new Set(["vaulkyrie-dkg", "vaulkyrie-session"]);

function encodeBase64Url(value: string): string {
  const encoded = btoa(value);
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return atob(padded);
  } catch {
    return null;
  }
}

function parseRelayUrlCandidate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseStructuredInvite(value: {
  protocol?: string;
  invite?: string;
  session?: string;
  authToken?: string;
  expires?: number;
  relayUrl?: string;
  relay?: string;
}): RelaySessionMetadata | null {
  const relayUrl = parseRelayUrlCandidate(value.relayUrl ?? value.relay);
  if (value.protocol && !SUPPORTED_INVITE_PROTOCOLS.has(value.protocol)) {
    return null;
  }

  if (typeof value.invite === "string") {
    const parsedInvite = parseSessionInvite(value.invite);
    if (!parsedInvite) return null;
    return { ...parsedInvite, relayUrl: relayUrl ?? parsedInvite.relayUrl };
  }

  if (typeof value.session === "string") {
    return createRelaySessionMetadata(
      normalizedInviteInput(value.session),
      typeof value.authToken === "string" ? normalizedInviteInput(value.authToken) : null,
      typeof value.expires === "number" ? value.expires : null,
      relayUrl,
    );
  }

  return null;
}

function parseInviteUrl(input: string): RelaySessionMetadata | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  const embeddedPayload =
    parsed.searchParams.get("payload") ??
    parsed.searchParams.get("data") ??
    (parsed.hash.startsWith("#payload=") ? parsed.hash.slice("#payload=".length) : null);
  if (embeddedPayload) {
    const decoded = decodeBase64Url(embeddedPayload);
    if (!decoded) return null;
    return parseSessionInvite(decoded);
  }

  const relayUrl = parseRelayUrlCandidate(
    parsed.searchParams.get("relayUrl") ?? parsed.searchParams.get("relay"),
  );
  const inviteParam =
    parsed.searchParams.get("invite") ??
    parsed.searchParams.get("session") ??
    parsed.searchParams.get("code");
  if (!inviteParam) {
    return null;
  }

  const parsedInvite = parseSessionInvite(inviteParam);
  if (!parsedInvite) return null;
  return { ...parsedInvite, relayUrl: relayUrl ?? parsedInvite.relayUrl };
}

function randomToken(length: number): string {
  let token = "";
  for (let index = 0; index < length; index += 1) {
    token += SESSION_CHARS[Math.floor(Math.random() * SESSION_CHARS.length)];
  }
  return token;
}

function normalizedInviteInput(input: string): string {
  return input.trim().toUpperCase();
}

export function generateSessionCode(): string {
  return randomToken(SESSION_CODE_LENGTH);
}

export function generateSessionAuthToken(): string {
  return randomToken(SESSION_AUTH_LENGTH);
}

export function buildSessionInvite(code: string, authToken?: string | null): string {
  return authToken ? `${code}.${authToken}` : code;
}

export function buildSessionVerificationPhrase(code: string, authToken?: string | null): string {
  const seed = `${code}:${authToken ?? "LOCAL"}`;
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 33 + character.charCodeAt(0)) % 1_000_003;
  }

  const adjective = VERIFICATION_ADJECTIVES[hash % VERIFICATION_ADJECTIVES.length];
  const noun =
    VERIFICATION_NOUNS[Math.floor(hash / VERIFICATION_ADJECTIVES.length) % VERIFICATION_NOUNS.length];
  const digits = String(hash % 1000).padStart(3, "0");
  return `${adjective}-${noun}-${digits}`;
}

export function createRelaySessionMetadata(
  code: string,
  authToken?: string | null,
  expiresAt?: number | null,
  relayUrl?: string | null,
): RelaySessionMetadata {
  return {
    code,
    authToken: authToken ?? null,
    invite: buildSessionInvite(code, authToken ?? null),
    verificationPhrase: buildSessionVerificationPhrase(code, authToken ?? null),
    expiresAt: expiresAt ?? null,
    relayUrl: relayUrl ?? null,
  };
}

export function parseSessionInvite(input: string): RelaySessionMetadata | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        protocol?: string;
        invite?: string;
        session?: string;
        authToken?: string;
        expires?: number;
        relayUrl?: string;
        relay?: string;
      };
      return parseStructuredInvite(parsed);
    } catch {
      return null;
    }
  }

  if (trimmed.includes("://")) {
    const parsedUrl = parseInviteUrl(trimmed);
    if (parsedUrl) {
      return parsedUrl;
    }
  }

  const normalized = normalizedInviteInput(trimmed);
  const match = normalized.match(/^([A-Z0-9]{6})(?:[^A-Z0-9]+([A-Z0-9]{8,16}))?$/);
  if (!match) return null;

  return createRelaySessionMetadata(match[1], match[2] ?? null, null, null);
}

export function buildSessionSharePayload(
  metadata: RelaySessionMetadata,
  relayUrl?: string | null,
): string {
  return JSON.stringify({
    protocol: "vaulkyrie-session",
    version: 1,
    session: metadata.code,
    authToken: metadata.authToken ?? undefined,
    invite: metadata.invite,
    verification: metadata.verificationPhrase,
    relayUrl: relayUrl ?? metadata.relayUrl ?? undefined,
    expires: metadata.expiresAt ?? undefined,
  });
}

export function buildSessionJoinUri(
  metadata: RelaySessionMetadata,
  relayUrl?: string | null,
): string {
  return `vaulkyrie://join?payload=${encodeBase64Url(buildSessionSharePayload(metadata, relayUrl))}`;
}

export function buildQrPayload(
  sessionId: string,
  threshold: number,
  participants: number,
  authToken?: string | null,
  expiresAt?: number | null,
  relayUrl?: string | null,
): string {
  const metadata = createRelaySessionMetadata(sessionId, authToken, expiresAt, relayUrl);
  return JSON.stringify({
    protocol: "vaulkyrie-dkg",
    version: 2,
    session: metadata.code,
    authToken: metadata.authToken ?? undefined,
    invite: metadata.invite,
    verification: metadata.verificationPhrase,
    relayUrl: metadata.relayUrl ?? undefined,
    threshold,
    participants,
    expires: metadata.expiresAt ?? Date.now() + 300_000,
  });
}
