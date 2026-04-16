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

// ── Configuration ────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8765", 10);
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL_MS = 30 * 1000;
const MAX_SESSIONS = 100;
const MAX_PARTICIPANTS_PER_SESSION = 10;

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
  createdAt: number;
  lastActivity: number;
  threshold: number;
  maxParticipants: number;
  members: Map<string, { ws: WebSocket; participantId: number; deviceName: string }>;
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

// ── HTTP server (health check + upgrade) ─────────────────────────────

const httpServer = http.createServer((_req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify({
    status: "ok",
    sessions: sessions.size,
    uptime: process.uptime(),
  }));
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

        const code = generateCode();
        const sessionPayload = msg.payload as { threshold?: number; maxParticipants?: number; deviceName?: string } | null;
        const session: Session = {
          code,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          threshold: sessionPayload?.threshold ?? 2,
          maxParticipants: sessionPayload?.maxParticipants ?? 3,
          members: new Map(),
        };

        session.members.set(msg.senderId, {
          ws,
          participantId: msg.participantId,
          deviceName: (sessionPayload?.deviceName as string) ?? "Unknown",
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
            threshold: session.threshold,
            maxParticipants: session.maxParticipants,
          },
        }));

        console.log(`[session] Created ${code} by participant ${msg.participantId}`);
        break;
      }

      case "join": {
        const joinPayload = msg.payload as { code?: string; deviceName?: string } | null;
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

        if (session.members.size >= MAX_PARTICIPANTS_PER_SESSION) {
          ws.send(JSON.stringify({
            type: "error",
            senderId: "server",
            payload: "Session is full",
          }));
          return;
        }

        session.members.set(msg.senderId, {
          ws,
          participantId: msg.participantId,
          deviceName: joinPayload?.deviceName ?? "Unknown",
        });
        session.lastActivity = Date.now();
        currentSessionCode = code;
        currentSenderId = msg.senderId;

        // Send join-ack to the joiner with current participant list
        const participantList = Array.from(session.members.entries()).map(([id, m]) => ({
          senderId: id,
          participantId: m.participantId,
          deviceName: m.deviceName,
        }));

        ws.send(JSON.stringify({
          type: "join-ack",
          sessionId: code,
          senderId: "server",
          participantId: 0,
          timestamp: Date.now(),
          payload: {
            participantId: msg.participantId,
            participants: participantList,
            threshold: session.threshold,
            maxParticipants: session.maxParticipants,
          },
        }));

        // Notify all other members
        broadcastToOthers(session, msg.senderId, {
          type: "participant-joined",
          sessionId: code,
          senderId: msg.senderId,
          participantId: msg.participantId,
          timestamp: Date.now(),
          payload: {
            senderId: msg.senderId,
            participantId: msg.participantId,
            deviceName: joinPayload?.deviceName ?? "Unknown",
          },
        });

        console.log(`[session] ${code}: participant ${msg.participantId} joined (${session.members.size}/${session.maxParticipants})`);
        break;
      }

      case "leave": {
        if (currentSessionCode && currentSenderId) {
          const session = sessions.get(currentSessionCode);
          if (session) {
            session.members.delete(currentSenderId);
            broadcastToOthers(session, currentSenderId, {
              type: "participant-left",
              sessionId: currentSessionCode,
              senderId: currentSenderId,
              participantId: msg.participantId,
              timestamp: Date.now(),
              payload: { senderId: currentSenderId },
            });

            if (session.members.size === 0) {
              sessions.delete(currentSessionCode);
              console.log(`[session] ${currentSessionCode}: closed (empty)`);
            }
          }
          currentSessionCode = null;
          currentSenderId = null;
        }
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
        broadcastToOthers(session, msg.senderId, msg);
        break;
      }
    }
  });

  ws.on("close", () => {
    if (currentSessionCode && currentSenderId) {
      const session = sessions.get(currentSessionCode);
      if (session) {
        session.members.delete(currentSenderId);
        broadcastToOthers(session, currentSenderId, {
          type: "participant-left",
          sessionId: currentSessionCode,
          senderId: currentSenderId,
          participantId: 0,
          timestamp: Date.now(),
          payload: { senderId: currentSenderId },
        });

        if (session.members.size === 0) {
          sessions.delete(currentSessionCode);
          console.log(`[session] ${currentSessionCode}: closed (empty)`);
        }
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

// ── Stale session cleanup ────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions) {
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
