import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { loadFrostWasm } from "./frost.js";
import { readSecureJsonFile, secureRelayStatePath, writeSecureJsonFile } from "./secureStorage.js";

type DeviceType = "browser" | "mobile" | "desktop";

interface RelayMessage {
  type: string;
  sessionId: string;
  senderId: string;
  participantId: number;
  timestamp: number;
  payload: unknown;
}

interface SignRequestPayload {
  requestId: string;
  message: number[];
  signerIds: number[];
  summary?: string;
}

export interface CosignerRecord {
  vaultId: string;
  groupPublicKeyHex: string;
  publicKeyPackage: string;
  keyPackage: string;
  participantId: number;
  label: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredCosigners {
  records: Record<string, CosignerRecord>;
}

export interface RegisterCosignerInput {
  vaultId: string;
  groupPublicKeyHex: string;
  publicKeyPackage: string;
  keyPackage: string;
  participantId: number;
  label?: string;
}

export interface RequestCosignerInput {
  vaultId: string;
  relayUrl: string;
  sessionInvite: string;
}

const relayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredStorePath = process.env.COSIGNER_STORE_PATH?.trim();
const storePath = configuredStorePath
  ? path.resolve(configuredStorePath)
  : secureRelayStatePath("cosigners.enc.json");
const legacyStorePaths = configuredStorePath
  ? []
  : [
      path.join(process.cwd(), ".vaulkyrie-cosigners.json"),
      path.join(relayRoot, ".vaulkyrie-cosigners.json"),
    ];

const activeSessions = new Map<string, Promise<void>>();

function readStore(): StoredCosigners {
  return readSecureJsonFile<StoredCosigners>(storePath, {
    fallback: { records: {} },
    legacyPaths: legacyStorePaths,
  });
}

function writeStore(store: StoredCosigners): void {
  writeSecureJsonFile(storePath, store);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

export function registerCosignerShare(input: RegisterCosignerInput): CosignerRecord {
  const vaultId = assertString(input.vaultId, "vaultId");
  const groupPublicKeyHex = assertString(input.groupPublicKeyHex, "groupPublicKeyHex");
  const publicKeyPackage = assertString(input.publicKeyPackage, "publicKeyPackage");
  const keyPackage = assertString(input.keyPackage, "keyPackage");
  const participantId = Number(input.participantId);

  if (!Number.isInteger(participantId) || participantId <= 0) {
    throw new Error("participantId must be a positive integer.");
  }

  JSON.parse(publicKeyPackage);
  JSON.parse(keyPackage);

  const now = Date.now();
  const store = readStore();
  const previous = store.records[vaultId];
  const record: CosignerRecord = {
    vaultId,
    groupPublicKeyHex,
    publicKeyPackage,
    keyPackage,
    participantId,
    label: input.label?.trim() || "Vaulkyrie Server Cosigner",
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  store.records[vaultId] = record;
  writeStore(store);
  return record;
}

export function getCosignerStatus(vaultId: string): Omit<CosignerRecord, "keyPackage"> | null {
  const record = readStore().records[vaultId];
  if (!record) return null;
  const safeRecord = { ...record };
  delete (safeRecord as Partial<CosignerRecord>).keyPackage;
  return safeRecord;
}

export function getCosignerCount(): number {
  return Object.keys(readStore().records).length;
}

export function requestCosignerSignature(input: RequestCosignerInput): { active: boolean; participantId: number } {
  const vaultId = assertString(input.vaultId, "vaultId");
  const relayUrl = assertString(input.relayUrl, "relayUrl");
  const sessionInvite = assertString(input.sessionInvite, "sessionInvite");
  const record = readStore().records[vaultId];

  if (!record) {
    throw new Error("No server cosigner is registered for this vault.");
  }

  const session = parseSessionInvite(sessionInvite);
  const sessionKey = `${vaultId}:${session.code}:${record.participantId}`;
  if (!activeSessions.has(sessionKey)) {
    const promise = runCosignerSession(record, relayUrl, session)
      .catch((error) => {
        console.error("[cosigner] Signing session failed:", error);
      })
      .finally(() => {
        activeSessions.delete(sessionKey);
      });
    activeSessions.set(sessionKey, promise);
  }

  return { active: true, participantId: record.participantId };
}

function parseSessionInvite(invite: string): { code: string; authToken: string | null } {
  const normalizedInvite = invite.trim().toUpperCase();
  const compactMatch = normalizedInvite.match(/^([A-Z0-9]{6})(?:[^A-Z0-9]+([A-Z0-9]{8,16}))?$/);
  if (compactMatch) {
    return { code: compactMatch[1], authToken: compactMatch[2] ?? null };
  }

  if (invite.startsWith("vaulkyrie://join?")) {
    const url = new URL(invite);
    const payload = url.searchParams.get("payload");
    if (!payload) {
      throw new Error("Session invite is missing a payload.");
    }
    return parseSessionInvite(Buffer.from(payload, "base64url").toString("utf8"));
  }

  if (invite.startsWith("VAULKYRIE_SESSION_V1.")) {
    const payload = invite.slice("VAULKYRIE_SESSION_V1.".length);
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      code?: string;
      session?: string;
      authToken?: string | null;
    };
    const code = assertString(parsed.code ?? parsed.session, "invite code").toUpperCase();
    return {
      code,
      authToken: typeof parsed.authToken === "string" ? parsed.authToken.toUpperCase() : null,
    };
  }

  try {
    const parsed = JSON.parse(invite) as {
      code?: string;
      session?: string;
      invite?: string;
      authToken?: string | null;
    };
    if (parsed.invite) {
      return parseSessionInvite(parsed.invite);
    }
    const code = assertString(parsed.code ?? parsed.session, "invite code").toUpperCase();
    return {
      code,
      authToken: typeof parsed.authToken === "string" ? parsed.authToken.toUpperCase() : null,
    };
  } catch {
    throw new Error("Invalid session invite.");
  }
}

function send(ws: WebSocket, partial: { type: string; sessionId?: string; senderId: string; participantId: number; payload: unknown }): void {
  const message: RelayMessage = {
    type: partial.type,
    sessionId: partial.sessionId ?? "",
    senderId: partial.senderId,
    participantId: partial.participantId,
    timestamp: Date.now(),
    payload: partial.payload,
  };
  ws.send(JSON.stringify(message));
}

async function runCosignerSession(
  record: CosignerRecord,
  relayUrl: string,
  session: { code: string; authToken: string | null },
): Promise<void> {
  const frost = await loadFrostWasm();
  const ws = new WebSocket(relayUrl);
  const senderId = `cosigner-${record.participantId}-${crypto.randomUUID()}`;
  const commitments = new Map<number, number[]>();
  let request: SignRequestPayload | null = null;
  let nonces: number[] | null = null;
  let shareSent = false;

  const closeTimer = setTimeout(() => {
    ws.close(1000, "Cosigner signing timeout");
  }, 120_000);

  const maybeSendShare = () => {
    if (!request || !nonces || shareSent) return;
    const required = request.signerIds.length;
    if (commitments.size < required) return;

    const commitmentsJson: Record<number, number[]> = {};
    for (const [participantId, value] of commitments) {
      commitmentsJson[participantId] = value;
    }

    const round2 = JSON.parse(
      frost.signing_round2(
        record.participantId,
        JSON.stringify(nonces),
        record.keyPackage,
        new Uint8Array(request.message),
        JSON.stringify(commitmentsJson),
      ),
    ) as { signature_share: number[] };

    shareSent = true;
    send(ws, {
      type: "sign-round2",
      sessionId: session.code,
      senderId,
      participantId: record.participantId,
      payload: round2.signature_share,
    });
  };

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      send(ws, {
        type: "join",
        senderId,
        participantId: record.participantId,
        payload: {
          code: session.code,
          authToken: session.authToken,
          deviceName: record.label,
          deviceType: "desktop" satisfies DeviceType,
        },
      });
    });

    ws.on("message", (raw) => {
      let message: RelayMessage;
      try {
        message = JSON.parse(raw.toString()) as RelayMessage;
      } catch {
        return;
      }

      if (message.type === "error") {
        reject(new Error(String(message.payload)));
        ws.close();
        return;
      }

      if (message.type === "join-ack") {
        console.log(`[cosigner] Joined session ${session.code} as participant ${record.participantId}`);
        return;
      }

      if (message.type === "sign-complete") {
        resolve();
        ws.close();
        return;
      }

      if (message.type === "sign-request") {
        request = message.payload as SignRequestPayload;
        if (!request.signerIds.includes(record.participantId)) {
          reject(new Error("Cosigner was not included in the signer set."));
          ws.close();
          return;
        }

        const round1 = JSON.parse(
          frost.signing_round1(record.participantId, record.keyPackage),
        ) as { nonces: number[]; commitments: number[] };

        nonces = round1.nonces;
        commitments.set(record.participantId, round1.commitments);
        send(ws, {
          type: "sign-round1",
          sessionId: session.code,
          senderId,
          participantId: record.participantId,
          payload: round1.commitments,
        });
        maybeSendShare();
        return;
      }

      if (message.type === "sign-round1") {
        commitments.set(message.participantId, message.payload as number[]);
        maybeSendShare();
      }
    });

    ws.once("error", reject);
    ws.once("close", () => {
      clearTimeout(closeTimer);
      if (!shareSent) {
        reject(new Error("Cosigner disconnected before producing a signature share."));
      } else {
        resolve();
      }
    });
  });
}
