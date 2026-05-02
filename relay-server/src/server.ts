/**
 * Vaulkyrie WebSocket relay server for cross-device DKG and signing ceremonies.
 *
 * This server is a dumb message router — it never inspects or stores crypto
 * state. Participants connect via WebSocket, join a session room by code,
 * and the server broadcasts messages to all other members of that room.
 *
 * Protocol (JSON over WebSocket):
 *   { type, sessionId, senderId, participantId, timestamp, payload }
 *
 * Session lifecycle:
 *   1. Creator sends "create-session" → server creates room, responds with code
 *   2. Joiners send "join" with session code → added to room
 *   3. All DKG/signing messages are broadcast to room members
 *   4. Sessions expire after SESSION_TTL_MS of inactivity
 */

import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import {
  getCosignerCount,
  getCosignerStatus,
  registerCosignerShare,
  requestCosignerSignature,
} from "./cosigner.js";
import { getPqcSponsorStatus, sponsorPqcWalletInit } from "./pqcSponsor.js";

// ── Configuration ────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8765", 10);
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL_MS = 30 * 1000;
const MAX_SESSIONS = 100;
const MAX_PARTICIPANTS_PER_SESSION = 10;
const MEMBER_STALE_MS = 45 * 1000;
const SESSION_AUTH_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_AUTH_LENGTH = 8;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// ── Types ────────────────────────────────────────────────────────────

interface RelayMessage {
  type: string;
  sessionId: string;
  senderId: string;
  participantId: number;
  timestamp: number;
  payload: unknown;
}

interface Session {
  code: string;
  authToken: string;
  createdAt: number;
  lastActivity: number;
  threshold: number;
  maxParticipants: number;
  members: Map<string, {
    ws: WebSocket;
    participantId: number;
    deviceName: string;
    deviceType: "browser" | "mobile" | "desktop";
    lastSeen: number;
  }>;
}

// ── State ────────────────────────────────────────────────────────────

const sessions = new Map<string, Session>();

// ── Session code generation ──────────────────────────────────────────

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  let code: string;
  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (sessions.has(code));
  return code;
}

function generateAuthToken(): string {
  let token = "";
  for (let index = 0; index < SESSION_AUTH_LENGTH; index += 1) {
    token += SESSION_AUTH_CHARS[Math.floor(Math.random() * SESSION_AUTH_CHARS.length)];
  }
  return token;
}

// ── HTTP server (health check + upgrade) ─────────────────────────────

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const remoteAddress = req.socket.remoteAddress;
  if (!remoteAddress) {
    return false;
  }

  return remoteAddress === "::1"
    || remoteAddress === "127.0.0.1"
    || remoteAddress === "::ffff:127.0.0.1";
}

function isAllowedCorsOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "chrome-extension:"
      || parsed.protocol === "moz-extension:"
      || (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname));
  } catch {
    return false;
  }
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const originHeader = req.headers.origin;
  const origin = typeof originHeader === "string" ? originHeader : null;
  if (!origin || !isAllowedCorsOrigin(origin)) {
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Cosigner-Token, X-Sponsor-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function writeJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  applyCors(req, res);
  res.writeHead(status, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function assertCosignerToken(req: http.IncomingMessage): void {
  const expected = process.env.COSIGNER_ADMIN_TOKEN;
  if (!expected) return;

  const actual = req.headers["x-cosigner-token"];
  if (actual !== expected) {
    throw new Error("Invalid cosigner token.");
  }
}

function assertSponsorToken(req: http.IncomingMessage): void {
  const expected = process.env.PQC_SPONSOR_ADMIN_TOKEN?.trim();
  if (!expected && isLoopbackRequest(req)) {
    return;
  }

  if (!expected) {
    throw new Error("PQC sponsor admin token is required for non-local requests.");
  }

  const actualHeader = req.headers["x-sponsor-token"];
  const actual = Array.isArray(actualHeader) ? actualHeader[0] : actualHeader;
  if (actual !== expected) {
    throw new Error("Invalid sponsor token.");
  }
}

const httpServer = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/cosigner/status") {
      const vaultId = url.searchParams.get("vaultId");
      writeJson(req, res, 200, {
        status: "ok",
        cosigner: vaultId ? getCosignerStatus(vaultId) : null,
        cosigners: getCosignerCount(),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/cosigner/register") {
      assertCosignerToken(req);
      const body = await readJsonBody(req);
      const record = registerCosignerShare(body as Parameters<typeof registerCosignerShare>[0]);
      const safeRecord = { ...record };
      delete (safeRecord as Partial<typeof record>).keyPackage;
      writeJson(req, res, 200, { status: "registered", cosigner: safeRecord });
      return;
    }

    if (req.method === "POST" && url.pathname === "/cosigner/sign") {
      assertCosignerToken(req);
      const body = await readJsonBody(req);
      const result = requestCosignerSignature(body as Parameters<typeof requestCosignerSignature>[0]);
      writeJson(req, res, 202, { status: "accepted", ...result });
      return;
    }

    if (req.method === "GET" && url.pathname === "/pqc/sponsor/status") {
      writeJson(req, res, 200, {
        status: "ok",
        sponsor: await getPqcSponsorStatus(url.searchParams.get("network") ?? undefined),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/pqc/sponsor/init") {
      assertSponsorToken(req);
      const body = await readJsonBody(req);
      const result = await sponsorPqcWalletInit(body as Parameters<typeof sponsorPqcWalletInit>[0]);
      writeJson(req, res, 202, { status: "accepted", ...result });
      return;
    }

    writeJson(req, res, 200, {
      status: "ok",
      sessions: sessions.size,
      cosigners: getCosignerCount(),
      pqcSponsor: await getPqcSponsorStatus().catch(() => null),
      uptime: process.uptime(),
    });
  } catch (error) {
    writeJson(req, res, 400, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// ── WebSocket server ─────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let currentSessionCode: string | null = null;
  let currentSenderId: string | null = null;

  ws.on("message", (raw) => {
    let msg: RelayMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", payload: "Invalid JSON" }));
      return;
    }

    switch (msg.type) {
      case "create-session": {
        if (sessions.size >= MAX_SESSIONS) {
          ws.send(JSON.stringify({ type: "error", payload: "Server full — too many active sessions" }));
          return;
        }

        const sessionPayload = msg.payload as {
          threshold?: number;
          maxParticipants?: number;
          deviceName?: string;
          deviceType?: "browser" | "mobile" | "desktop";
          requestedCode?: string;
        } | null;

        // Accept client-specified code if available and not already in use
        let code: string;
        if (sessionPayload?.requestedCode && /^[A-Z0-9]{6}$/.test(sessionPayload.requestedCode) && !sessions.has(sessionPayload.requestedCode)) {
          code = sessionPayload.requestedCode;
        } else {
          code = generateCode();
        }

        const session: Session = {
          code,
          authToken: generateAuthToken(),
          createdAt: Date.now(),
          lastActivity: Date.now(),
          threshold: sessionPayload?.threshold ?? 2,
          maxParticipants: Math.min(sessionPayload?.maxParticipants ?? 3, MAX_PARTICIPANTS_PER_SESSION),
          members: new Map(),
        };

        const requestedParticipantId =
          Number.isInteger(msg.participantId) && msg.participantId > 0
            ? msg.participantId
            : 1;

        session.members.set(msg.senderId, {
          ws,
          participantId: requestedParticipantId,
          deviceName: (sessionPayload?.deviceName as string) ?? "Unknown",
          deviceType: sessionPayload?.deviceType ?? "browser",
          lastSeen: Date.now(),
        });

        sessions.set(code, session);
        currentSessionCode = code;
        currentSenderId = msg.senderId;

        ws.send(JSON.stringify({
          type: "session-created",
          sessionId: code,
          senderId: "server",
          participantId: 0,
          timestamp: Date.now(),
          payload: {
            code,
            authToken: session.authToken,
            threshold: session.threshold,
            maxParticipants: session.maxParticipants,
            expiresAt: session.lastActivity + SESSION_TTL_MS,
          },
        }));

        console.log(`[session] Created ${code} by participant ${msg.participantId}`);
        break;
      }

      case "join": {
        const joinPayload = msg.payload as {
          code?: string;
          authToken?: string;
          deviceName?: string;
          deviceType?: "browser" | "mobile" | "desktop";
        } | null;
        const code = joinPayload?.code ?? msg.sessionId;
        const session = sessions.get(code);

        if (!session) {
          ws.send(JSON.stringify({
            type: "error",
            senderId: "server",
            payload: `Session ${code} not found`,
          }));
          return;
        }

        if (!joinPayload?.authToken || joinPayload.authToken !== session.authToken) {
          ws.send(JSON.stringify({
            type: "error",
            senderId: "server",
            payload: "Invalid or expired session invite.",
          }));
          return;
        }

        if (session.members.size >= Math.min(MAX_PARTICIPANTS_PER_SESSION, session.maxParticipants)) {
          ws.send(JSON.stringify({
            type: "error",
            senderId: "server",
            payload: "Session is full",
          }));
          return;
        }

        const requestedParticipantId =
          Number.isInteger(msg.participantId) && msg.participantId > 0
            ? msg.participantId
            : 0;
        const usedParticipantIds = new Set(
          Array.from(session.members.values()).map((member) => member.participantId),
        );
        let assignedParticipantId = requestedParticipantId;
        if (assignedParticipantId <= 0 || usedParticipantIds.has(assignedParticipantId)) {
          assignedParticipantId = 1;
          while (usedParticipantIds.has(assignedParticipantId)) {
            assignedParticipantId += 1;
          }
        }

        session.members.set(msg.senderId, {
          ws,
          participantId: assignedParticipantId,
          deviceName: joinPayload?.deviceName ?? "Unknown",
          deviceType: joinPayload?.deviceType ?? "browser",
          lastSeen: Date.now(),
        });
        session.lastActivity = Date.now();
        currentSessionCode = code;
        currentSenderId = msg.senderId;

        // Send join-ack to the joiner with assigned ID and current participant list
        const participantList = Array.from(session.members.entries()).map(([id, m]) => ({
          senderId: id,
          participantId: m.participantId,
          deviceName: m.deviceName,
          deviceType: m.deviceType,
        }));

        ws.send(JSON.stringify({
          type: "join-ack",
          sessionId: code,
          senderId: "server",
          participantId: 0,
          timestamp: Date.now(),
          payload: {
          participantId: assignedParticipantId,
          participants: participantList,
          threshold: session.threshold,
          maxParticipants: session.maxParticipants,
          expiresAt: session.lastActivity + SESSION_TTL_MS,
        },
      }));

        // Notify all other members
        broadcastToOthers(session, msg.senderId, {
          type: "participant-joined",
          sessionId: code,
          senderId: msg.senderId,
          participantId: assignedParticipantId,
          timestamp: Date.now(),
          payload: {
            senderId: msg.senderId,
            participantId: assignedParticipantId,
            deviceName: joinPayload?.deviceName ?? "Unknown",
            deviceType: joinPayload?.deviceType ?? "browser",
          },
        });

        console.log(`[session] ${code}: participant ${msg.participantId} joined (${session.members.size}/${session.maxParticipants})`);
        break;
      }

      case "leave": {
        if (currentSessionCode && currentSenderId) {
          const session = sessions.get(currentSessionCode);
          if (session) {
            const participantId = session.members.get(currentSenderId)?.participantId ?? msg.participantId;
            removeMemberFromSession(session, currentSessionCode, currentSenderId, participantId);
          }
          currentSessionCode = null;
          currentSenderId = null;
        }
        break;
      }

      // Heartbeat — always respond, even without a session
      case "Ping": {
        if (currentSessionCode && currentSenderId) {
          const session = sessions.get(currentSessionCode);
          const member = session?.members.get(currentSenderId);
          if (session && member) {
            session.lastActivity = Date.now();
            member.lastSeen = Date.now();
          }
        }
        ws.send(JSON.stringify({ type: "Pong", sessionId: currentSessionCode ?? "", senderId: "server", participantId: 0, timestamp: Date.now(), payload: null }));
        break;
      }

      // All DKG/signing messages — just relay to room
      default: {
        if (!currentSessionCode) {
          ws.send(JSON.stringify({ type: "error", payload: "Not in a session" }));
          return;
        }

        const session = sessions.get(currentSessionCode);
        if (!session) return;

        session.lastActivity = Date.now();
        const member = currentSenderId ? session.members.get(currentSenderId) : null;
        if (!member || !currentSenderId) {
          ws.send(JSON.stringify({ type: "error", payload: "Session membership is no longer valid" }));
          return;
        }

        member.lastSeen = Date.now();
        broadcastToOthers(session, currentSenderId, {
          ...msg,
          sessionId: currentSessionCode,
          senderId: currentSenderId,
          participantId: member.participantId,
          timestamp: Date.now(),
        });
        break;
      }
    }
  });

  ws.on("close", () => {
    if (currentSessionCode && currentSenderId) {
      const session = sessions.get(currentSessionCode);
      if (session) {
        const participantId = session.members.get(currentSenderId)?.participantId ?? 0;
        removeMemberFromSession(session, currentSessionCode, currentSenderId, participantId);
      }
    }
  });

  ws.on("error", (err) => {
    console.error("[ws] Client error:", err.message);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

function broadcastToOthers(session: Session, excludeSenderId: string, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const [id, member] of session.members) {
    if (id !== excludeSenderId && member.ws.readyState === WebSocket.OPEN) {
      member.ws.send(data);
    }
  }
}

function removeMemberFromSession(
  session: Session,
  sessionCode: string,
  senderId: string,
  participantId: number,
): void {
  if (!session.members.has(senderId)) {
    return;
  }

  session.members.delete(senderId);
  session.lastActivity = Date.now();
  broadcastToOthers(session, senderId, {
    type: "participant-left",
    sessionId: sessionCode,
    senderId,
    participantId,
    timestamp: Date.now(),
    payload: { senderId },
  });

  if (session.members.size === 0) {
    sessions.delete(sessionCode);
    console.log(`[session] ${sessionCode}: closed (empty)`);
  }
}

// ── Stale session cleanup ────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions) {
    for (const [senderId, member] of session.members) {
      const stale =
        member.ws.readyState !== WebSocket.OPEN || now - member.lastSeen > MEMBER_STALE_MS;
      if (stale) {
        if (member.ws.readyState === WebSocket.OPEN) {
          member.ws.close(1000, "Member stale");
        }
        removeMemberFromSession(session, code, senderId, member.participantId);
      }
    }

    if (!sessions.has(code)) {
      continue;
    }

    if (now - session.lastActivity > SESSION_TTL_MS) {
      // Notify remaining members
      for (const [, member] of session.members) {
        if (member.ws.readyState === WebSocket.OPEN) {
          member.ws.send(JSON.stringify({
            type: "session-expired",
            sessionId: code,
            senderId: "server",
            participantId: 0,
            timestamp: now,
            payload: null,
          }));
          member.ws.close(1000, "Session expired");
        }
      }
      sessions.delete(code);
      console.log(`[cleanup] Session ${code} expired`);
    }
  }
}, CLEANUP_INTERVAL_MS);

// ── Start ────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[relay] Vaulkyrie relay server listening on ws://localhost:${PORT}`);
});
