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
): RelaySessionMetadata {
  return {
    code,
    authToken: authToken ?? null,
    invite: buildSessionInvite(code, authToken ?? null),
    verificationPhrase: buildSessionVerificationPhrase(code, authToken ?? null),
    expiresAt: expiresAt ?? null,
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
      };
      if (parsed.protocol === "vaulkyrie-dkg") {
        if (typeof parsed.invite === "string") {
          return parseSessionInvite(parsed.invite);
        }
        if (typeof parsed.session === "string") {
          return createRelaySessionMetadata(
            normalizedInviteInput(parsed.session),
            typeof parsed.authToken === "string" ? normalizedInviteInput(parsed.authToken) : null,
            typeof parsed.expires === "number" ? parsed.expires : null,
          );
        }
      }
    } catch {
      return null;
    }
  }

  const normalized = normalizedInviteInput(trimmed);
  const match = normalized.match(/^([A-Z0-9]{6})(?:[^A-Z0-9]+([A-Z0-9]{8,16}))?$/);
  if (!match) return null;

  return createRelaySessionMetadata(match[1], match[2] ?? null, null);
}

export function buildQrPayload(
  sessionId: string,
  threshold: number,
  participants: number,
  authToken?: string | null,
  expiresAt?: number | null,
): string {
  const metadata = createRelaySessionMetadata(sessionId, authToken, expiresAt);
  return JSON.stringify({
    protocol: "vaulkyrie-dkg",
    version: 2,
    session: metadata.code,
    authToken: metadata.authToken ?? undefined,
    invite: metadata.invite,
    verification: metadata.verificationPhrase,
    threshold,
    participants,
    expires: metadata.expiresAt ?? Date.now() + 300_000,
  });
}
