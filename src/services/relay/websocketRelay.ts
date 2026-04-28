/**
 * WebSocket relay client for cross-device DKG and signing ceremonies.
 *
 * Connects to the Vaulkyrie relay server and provides the same event-driven
 * interface as ChannelRelay, but works across different devices/browsers.
 *
 * Features:
 *   - Auto-reconnection with exponential backoff
 *   - Session creation and joining via 6-char codes
 *   - Heartbeat to keep the connection alive
 *   - Same RelayEvents callback interface as ChannelRelay
 */

import type { RelayEvents, RelayParticipant, JoinPayload, SignRequestPayload } from "./channelRelay";
import { RelayMessageType } from "./channelRelay";
import {
  buildSessionInvite,
  createRelaySessionMetadata,
  parseSessionInvite,
  type RelaySessionMetadata,
} from "./sessionInvite";

export { RelayMessageType };
export type { RelayEvents, RelayParticipant };

// ── Configuration ────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = "ws://localhost:8765";
const HEARTBEAT_INTERVAL = 5000;
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 15000;
const MAX_RECONNECT_ATTEMPTS = 5;

// ── Relay message (matches server protocol) ──────────────────────────

export interface WsRelayMessage {
  type: string;
  sessionId: string;
  senderId: string;
  participantId: number;
  timestamp: number;
  payload: unknown;
}

// ── Connection state ─────────────────────────────────────────────────

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";

export interface WebSocketRelayOptions {
  relayUrl?: string;
  participantId: number;
  isCoordinator: boolean;
  deviceName: string;
  deviceType: "browser" | "mobile" | "desktop";
  events: RelayEvents;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onSessionCreated?: (session: RelaySessionMetadata) => void;
  onParticipantIdAssigned?: (id: number) => void;
}

// ── WebSocketRelay class ─────────────────────────────────────────────

export class WebSocketRelay {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private pendingMessages: Array<{ type: string; payload: unknown }> = [];

  private connectionState: ConnectionState = "disconnected";
  private sessionCode: string | null = null;
  private sessionAuthToken: string | null = null;
  private sessionExpiresAt: number | null = null;

  readonly relayUrl: string;
  readonly senderId: string;
  participantId: number;
  readonly isCoordinator: boolean;
  readonly deviceName: string;
  readonly deviceType: "browser" | "mobile" | "desktop";

  private participants = new Map<string, RelayParticipant>();
  private events: RelayEvents;
  private onConnectionStateChange?: (state: ConnectionState) => void;
  private onSessionCreated?: (session: RelaySessionMetadata) => void;
  private onParticipantIdAssigned?: (id: number) => void;

  constructor(opts: WebSocketRelayOptions) {
    this.relayUrl = opts.relayUrl ?? DEFAULT_RELAY_URL;
    this.senderId = crypto.randomUUID();
    this.participantId = opts.participantId;
    this.isCoordinator = opts.isCoordinator;
    this.deviceName = opts.deviceName;
    this.deviceType = opts.deviceType;
    this.events = opts.events;
    this.onConnectionStateChange = opts.onConnectionStateChange;
    this.onSessionCreated = opts.onSessionCreated;
    this.onParticipantIdAssigned = opts.onParticipantIdAssigned;

    // Add self to participants
    this.participants.set(this.senderId, {
      senderId: this.senderId,
      participantId: opts.participantId,
      deviceName: opts.deviceName,
      deviceType: opts.deviceType,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    });
  }

  // ── Connection lifecycle ──────────────────────────────────────────

  /** Connect to the relay server */
  connect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.intentionallyClosed = false;
    this.setConnectionState("connecting");

    try {
      this.ws = new WebSocket(this.relayUrl);
    } catch (err) {
      console.error("[ws-relay] Failed to create WebSocket:", err);
      this.setConnectionState("failed");
      return;
    }

    this.ws.onopen = () => {
      this.setConnectionState("connected");
      this.reconnectAttempts = 0;
      // Flush any messages queued before connection opened
      this.flushPendingMessages();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: WsRelayMessage = JSON.parse(event.data as string);
        this.handleMessage(msg);
      } catch (err) {
        console.error("[ws-relay] Failed to parse message:", err);
      }
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      if (!this.intentionallyClosed) {
        this.attemptReconnect();
      } else {
        this.setConnectionState("disconnected");
      }
    };

    this.ws.onerror = (err) => {
      console.error("[ws-relay] WebSocket error:", err);
    };
  }

  /** Disconnect and clean up */
  disconnect(): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: "leave", payload: null });
      }
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }

    this.setConnectionState("disconnected");
  }

  /** Create a new session (coordinator only). Sends the desired session code to the server. */
  createSession(threshold: number, maxParticipants: number, requestedCode?: string): void {
    if (requestedCode) {
      this.sessionCode = requestedCode;
    }
    this.sendOrQueue({
      type: "create-session",
      payload: {
        threshold,
        maxParticipants,
        deviceName: this.deviceName,
        deviceType: this.deviceType,
        requestedCode: requestedCode ?? this.sessionCode,
      },
    });
  }

  /** Join an existing session by invite or code */
  joinSession(invite: string): void {
    const parsedInvite = parseSessionInvite(invite);
    if (!parsedInvite) {
      this.events.onError?.(0, "Invalid relay session invite.");
      return;
    }

    this.sessionCode = parsedInvite.code;
    this.sessionAuthToken = parsedInvite.authToken;
    this.sessionExpiresAt = parsedInvite.expiresAt;
    this.sendOrQueue({
      type: "join",
      payload: {
        code: parsedInvite.code,
        authToken: parsedInvite.authToken,
        deviceName: this.deviceName,
        deviceType: this.deviceType,
      },
    });
  }

  /** Get the session code (available after creation or joining) */
  getSessionCode(): string | null {
    return this.sessionCode;
  }

  /** Get the current shareable invite, when available */
  getSessionInvite(): string | null {
    return this.sessionCode ? buildSessionInvite(this.sessionCode, this.sessionAuthToken) : null;
  }

  /** Get current connection state */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /** Get all connected participants (including self) */
  getParticipants(): RelayParticipant[] {
    return Array.from(this.participants.values());
  }

  /** Get participant count */
  get participantCount(): number {
    return this.participants.size;
  }

  // ── Broadcasting helpers (same API as ChannelRelay) ───────────────

  broadcastDkgRound1(pkg: number[]): void {
    this.send({ type: RelayMessageType.DkgRound1, payload: pkg });
  }

  broadcastDkgRound2(packages: Record<number, number[]>): void {
    this.send({ type: RelayMessageType.DkgRound2, payload: packages });
  }

  broadcastDkgRound3Done(groupKeyHex: string): void {
    this.send({ type: RelayMessageType.DkgRound3Done, payload: groupKeyHex });
  }

  broadcastSignRequest(request: SignRequestPayload): void {
    this.send({ type: RelayMessageType.SignRequest, payload: request });
  }

  broadcastSignRound1(commitments: number[]): void {
    this.send({ type: RelayMessageType.SignRound1, payload: commitments });
  }

  broadcastSignRound2(share: number[]): void {
    this.send({ type: RelayMessageType.SignRound2, payload: share });
  }

  broadcastSignComplete(signatureHex: string, verified: boolean): void {
    this.send({ type: RelayMessageType.SignComplete, payload: { signatureHex, verified } });
  }

  broadcastStartDkg(threshold: number, participants: number): void {
    this.send({ type: RelayMessageType.StartDkg, payload: { threshold, participants } });
  }

  broadcastError(error: string): void {
    this.send({ type: RelayMessageType.Error, payload: error });
  }

  // ── Internal ──────────────────────────────────────────────────────

  /** Queue a message to send when connected, or send immediately */
  private sendOrQueue(partial: { type: string; payload: unknown }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(partial);
    } else {
      this.pendingMessages.push(partial);
    }
  }

  /** Flush queued messages after connection opens */
  private flushPendingMessages(): void {
    const queued = this.pendingMessages.splice(0);
    for (const msg of queued) {
      this.send(msg);
    }
  }

  private send(partial: { type: string; payload: unknown }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[ws-relay] Cannot send — not connected");
      return;
    }

    const msg: WsRelayMessage = {
      type: partial.type,
      sessionId: this.sessionCode ?? "",
      senderId: this.senderId,
      participantId: this.participantId,
      timestamp: Date.now(),
      payload: partial.payload,
    };

    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(msg: WsRelayMessage): void {
    // Server-originated messages
    switch (msg.type) {
      case "session-created": {
        const sp = msg.payload as {
          code: string;
          authToken?: string | null;
          threshold: number;
          maxParticipants: number;
          expiresAt?: number | null;
        };
        this.sessionCode = sp.code;
        this.sessionAuthToken = sp.authToken ?? null;
        this.sessionExpiresAt = sp.expiresAt ?? null;
        this.startHeartbeat();
        this.onSessionCreated?.(
          createRelaySessionMetadata(sp.code, sp.authToken ?? null, sp.expiresAt ?? null, this.relayUrl),
        );
        return;
      }

      case "join-ack": {
        const jp = msg.payload as {
          participantId: number;
          participants: Array<{
            senderId: string;
            participantId: number;
            deviceName: string;
            deviceType?: "browser" | "mobile" | "desktop";
          }>;
          threshold: number;
          maxParticipants: number;
          expiresAt?: number | null;
        };
        // Update our own participant ID from server assignment
        if (jp.participantId > 0) {
          this.participantId = jp.participantId;
          // Update our own entry in participants map
          const self = this.participants.get(this.senderId);
          if (self) self.participantId = jp.participantId;
          this.onParticipantIdAssigned?.(jp.participantId);
        }
        this.sessionExpiresAt = jp.expiresAt ?? this.sessionExpiresAt;
        this.startHeartbeat();
        // Populate participant list from server state
        for (const p of jp.participants) {
          if (p.senderId !== this.senderId && !this.participants.has(p.senderId)) {
            const participant: RelayParticipant = {
              senderId: p.senderId,
              participantId: p.participantId,
              deviceName: p.deviceName,
              deviceType: p.deviceType ?? "browser",
              joinedAt: Date.now(),
              lastSeen: Date.now(),
            };
            this.participants.set(p.senderId, participant);
            this.events.onParticipantJoined?.(participant);
          }
        }
        return;
      }

      case "participant-joined": {
        const pj = msg.payload as {
          senderId: string;
          participantId: number;
          deviceName: string;
          deviceType?: "browser" | "mobile" | "desktop";
        };
        if (!this.participants.has(pj.senderId)) {
          const participant: RelayParticipant = {
            senderId: pj.senderId,
            participantId: pj.participantId,
            deviceName: pj.deviceName,
            deviceType: pj.deviceType ?? "browser",
            joinedAt: Date.now(),
            lastSeen: Date.now(),
          };
          this.participants.set(pj.senderId, participant);
          this.events.onParticipantJoined?.(participant);
        }
        return;
      }

      case "participant-left": {
        const pl = msg.payload as { senderId: string };
        this.participants.delete(pl.senderId);
        this.events.onParticipantLeft?.(pl.senderId);
        return;
      }

      case "session-expired": {
        this.sessionExpiresAt = Date.now();
        this.events.onError?.(0, "Session expired");
        this.disconnect();
        return;
      }

      case "error": {
        this.events.onError?.(0, msg.payload as string);
        return;
      }
    }

    // Update lastSeen for known participants
    const existing = this.participants.get(msg.senderId);
    if (existing) {
      existing.lastSeen = Date.now();
    }

    // DKG/signing protocol messages — dispatch to event handlers
    switch (msg.type) {
      case RelayMessageType.Join: {
        const jp = msg.payload as JoinPayload;
        if (!this.participants.has(msg.senderId)) {
          const participant: RelayParticipant = {
            senderId: msg.senderId,
            participantId: msg.participantId,
            deviceName: jp.deviceName,
            deviceType: jp.deviceType,
            joinedAt: msg.timestamp,
            lastSeen: Date.now(),
          };
          this.participants.set(msg.senderId, participant);
          this.events.onParticipantJoined?.(participant);
        }
        break;
      }

      case RelayMessageType.StartDkg: {
        const sp = msg.payload as { threshold: number; participants: number };
        this.events.onStartDkg?.(sp.threshold, sp.participants);
        break;
      }

      case RelayMessageType.DkgRound1:
        this.events.onDkgRound1?.(msg.participantId, msg.payload as number[]);
        break;

      case RelayMessageType.DkgRound2:
        this.events.onDkgRound2?.(msg.participantId, msg.payload as Record<number, number[]>);
        break;

      case RelayMessageType.DkgRound3Done:
        this.events.onDkgRound3Done?.(msg.participantId, msg.payload as string);
        break;

      case RelayMessageType.SignRequest:
        this.events.onSignRequest?.(msg.participantId, msg.payload as SignRequestPayload);
        break;

      case RelayMessageType.SignRound1:
        this.events.onSignRound1?.(msg.participantId, msg.payload as number[]);
        break;

      case RelayMessageType.SignRound2:
        this.events.onSignRound2?.(msg.participantId, msg.payload as number[]);
        break;

      case RelayMessageType.SignComplete: {
        const sc = msg.payload as { signatureHex: string; verified: boolean };
        this.events.onSignComplete?.(sc.signatureHex, sc.verified);
        break;
      }

      case RelayMessageType.Error:
        this.events.onError?.(msg.participantId, msg.payload as string);
        break;

      case RelayMessageType.Ping:
        // Just updates lastSeen (handled above)
        break;
    }
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.onConnectionStateChange?.(state);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: RelayMessageType.Ping, payload: null });
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setConnectionState("failed");
      return;
    }

    this.setConnectionState("reconnecting");
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      console.log(`[ws-relay] Reconnecting (attempt ${this.reconnectAttempts})...`);
      this.connect();

      // Re-join session after reconnect
      if (this.sessionCode) {
        setTimeout(() => {
          if (this.ws?.readyState === WebSocket.OPEN && this.sessionCode) {
            this.joinSession(buildSessionInvite(this.sessionCode, this.sessionAuthToken));
          }
        }, 500);
      }
    }, delay);
  }
}
