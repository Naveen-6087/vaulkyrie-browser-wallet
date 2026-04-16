/**
 * Unified relay adapter — factory that creates the appropriate relay
 * implementation based on the connection mode.
 *
 * - "local" → BroadcastChannel (same-browser tabs, no server needed)
 * - "remote" → WebSocket relay (cross-device/browser, requires relay server)
 */

import { ChannelRelay, generateSessionCode, buildQrPayload } from "./channelRelay";
import { WebSocketRelay, type ConnectionState, type WebSocketRelayOptions } from "./websocketRelay";
import type { RelayEvents, RelayParticipant } from "./channelRelay";

export { generateSessionCode, buildQrPayload };
export type { RelayEvents, RelayParticipant, ConnectionState };

export type RelayMode = "local" | "remote";

export interface RelayAdapter {
  readonly mode: RelayMode;
  readonly participantId: number;
  readonly isCoordinator: boolean;

  connect(): void;
  disconnect(): void;

  getParticipants(): RelayParticipant[];
  readonly participantCount: number;
  getSessionCode(): string | null;
  getConnectionState(): ConnectionState;

  // Session management (remote only)
  createSession(threshold: number, maxParticipants: number, requestedCode?: string): void;
  joinSession(code: string): void;

  // DKG broadcasting
  broadcastDkgRound1(pkg: number[]): void;
  broadcastDkgRound2(packages: Record<number, number[]>): void;
  broadcastDkgRound3Done(groupKeyHex: string): void;
  broadcastStartDkg(threshold: number, participants: number): void;

  // Signing broadcasting
  broadcastSignRound1(commitments: number[]): void;
  broadcastSignRound2(share: number[]): void;
  broadcastSignComplete(signatureHex: string, verified: boolean): void;

  broadcastError(error: string): void;
}

// ── Local adapter (wraps ChannelRelay) ───────────────────────────────

class LocalRelayAdapter implements RelayAdapter {
  readonly mode: RelayMode = "local";
  readonly participantId: number;
  readonly isCoordinator: boolean;

  private relay: ChannelRelay;
  private sessionId: string;

  constructor(opts: {
    sessionId: string;
    participantId: number;
    isCoordinator: boolean;
    deviceName: string;
    events: RelayEvents;
  }) {
    this.participantId = opts.participantId;
    this.isCoordinator = opts.isCoordinator;
    this.sessionId = opts.sessionId;
    this.relay = new ChannelRelay({
      sessionId: opts.sessionId,
      participantId: opts.participantId,
      isCoordinator: opts.isCoordinator,
      deviceName: opts.deviceName,
      deviceType: "browser",
      events: opts.events,
    });
  }

  connect() { this.relay.connect(); }
  disconnect() { this.relay.disconnect(); }
  getParticipants() { return this.relay.getParticipants(); }
  get participantCount() { return this.relay.participantCount; }
  getSessionCode() { return this.sessionId; }
  getConnectionState(): ConnectionState { return "connected"; }

  createSession() { /* no-op for local */ }
  joinSession() { /* no-op for local — session is the BroadcastChannel name */ }

  broadcastDkgRound1(pkg: number[]) { this.relay.broadcastDkgRound1(pkg); }
  broadcastDkgRound2(packages: Record<number, number[]>) { this.relay.broadcastDkgRound2(packages); }
  broadcastDkgRound3Done(groupKeyHex: string) { this.relay.broadcastDkgRound3Done(groupKeyHex); }
  broadcastStartDkg(threshold: number, participants: number) { this.relay.broadcastStartDkg(threshold, participants); }

  broadcastSignRound1(commitments: number[]) { this.relay.broadcastSignRound1(commitments); }
  broadcastSignRound2(share: number[]) { this.relay.broadcastSignRound2(share); }
  broadcastSignComplete(signatureHex: string, verified: boolean) { this.relay.broadcastSignComplete(signatureHex, verified); }

  broadcastError(error: string) { this.relay.broadcastError(error); }
}

// ── Remote adapter (wraps WebSocketRelay) ────────────────────────────

class RemoteRelayAdapter implements RelayAdapter {
  readonly mode: RelayMode = "remote";
  get participantId() { return this.relay.participantId; }
  readonly isCoordinator: boolean;

  private relay: WebSocketRelay;

  constructor(opts: WebSocketRelayOptions) {
    this.isCoordinator = opts.isCoordinator;
    this.relay = new WebSocketRelay(opts);
  }

  connect() { this.relay.connect(); }
  disconnect() { this.relay.disconnect(); }
  getParticipants() { return this.relay.getParticipants(); }
  get participantCount() { return this.relay.participantCount; }
  getSessionCode() { return this.relay.getSessionCode(); }
  getConnectionState() { return this.relay.getConnectionState(); }

  createSession(threshold: number, maxParticipants: number, requestedCode?: string) { this.relay.createSession(threshold, maxParticipants, requestedCode); }
  joinSession(code: string) { this.relay.joinSession(code); }

  broadcastDkgRound1(pkg: number[]) { this.relay.broadcastDkgRound1(pkg); }
  broadcastDkgRound2(packages: Record<number, number[]>) { this.relay.broadcastDkgRound2(packages); }
  broadcastDkgRound3Done(groupKeyHex: string) { this.relay.broadcastDkgRound3Done(groupKeyHex); }
  broadcastStartDkg(threshold: number, participants: number) { this.relay.broadcastStartDkg(threshold, participants); }

  broadcastSignRound1(commitments: number[]) { this.relay.broadcastSignRound1(commitments); }
  broadcastSignRound2(share: number[]) { this.relay.broadcastSignRound2(share); }
  broadcastSignComplete(signatureHex: string, verified: boolean) { this.relay.broadcastSignComplete(signatureHex, verified); }

  broadcastError(error: string) { this.relay.broadcastError(error); }
}

// ── Factory ──────────────────────────────────────────────────────────

export interface CreateRelayOptions {
  mode: RelayMode;
  participantId: number;
  isCoordinator: boolean;
  deviceName: string;
  deviceType?: "browser" | "mobile" | "desktop";
  events: RelayEvents;

  // Local mode
  sessionId?: string;

  // Remote mode
  relayUrl?: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onSessionCreated?: (code: string) => void;
  onParticipantIdAssigned?: (id: number) => void;
}

export function createRelay(opts: CreateRelayOptions): RelayAdapter {
  if (opts.mode === "local") {
    return new LocalRelayAdapter({
      sessionId: opts.sessionId ?? generateSessionCode(),
      participantId: opts.participantId,
      isCoordinator: opts.isCoordinator,
      deviceName: opts.deviceName,
      events: opts.events,
    });
  }

  return new RemoteRelayAdapter({
    relayUrl: opts.relayUrl,
    participantId: opts.participantId,
    isCoordinator: opts.isCoordinator,
    deviceName: opts.deviceName,
    deviceType: opts.deviceType ?? "browser",
    events: opts.events,
    onConnectionStateChange: opts.onConnectionStateChange,
    onSessionCreated: opts.onSessionCreated,
    onParticipantIdAssigned: opts.onParticipantIdAssigned,
  });
}

/** Default relay server URL — can be overridden via environment or settings */
export const DEFAULT_RELAY_URL = import.meta.env.VITE_RELAY_URL ?? "ws://localhost:8765";
