/**
 * Unified relay adapter — factory that creates the appropriate relay
 * implementation based on the connection mode.
 *
 * - "local" → BroadcastChannel (same-browser tabs, no server needed)
 * - "remote" → WebSocket relay (cross-device/browser, requires relay server)
 */

import { ChannelRelay } from "./channelRelay";
import { WebSocketRelay, type ConnectionState, type WebSocketRelayOptions } from "./websocketRelay";
import type { RelayEvents, RelayParticipant, SignRequestPayload } from "./channelRelay";
import {
  buildQrPayload,
  generateSessionCode,
  parseSessionInvite,
  type RelaySessionMetadata,
} from "./sessionInvite";

export { buildQrPayload, generateSessionCode, parseSessionInvite };
export type { RelayEvents, RelayParticipant, ConnectionState };
export type { RelaySessionMetadata };

export type RelayMode = "local" | "remote";
const LOCAL_RELAY_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function inferHostedRelayUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const { protocol, host } = window.location;
  const hostname = window.location.hostname;
  if (LOCAL_RELAY_HOSTS.has(hostname)) {
    return null;
  }

  if (protocol === "https:" || protocol === "http:") {
    const relayProtocol = protocol === "https:" ? "wss:" : "ws:";
    return `${relayProtocol}//${host}/relay`;
  }

  return null;
}

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
  joinSession(invite: string): void;

  // DKG broadcasting
  broadcastDkgRound1(pkg: number[]): void;
  broadcastDkgRound2(packages: Record<number, number[]>): void;
  broadcastDkgRound3Done(groupKeyHex: string): void;
  broadcastStartDkg(threshold: number, participants: number): void;

  // Signing broadcasting
  broadcastSignRequest(request: SignRequestPayload): void;
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

  broadcastSignRequest(request: SignRequestPayload) { this.relay.broadcastSignRequest(request); }
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

  broadcastSignRequest(request: SignRequestPayload) { this.relay.broadcastSignRequest(request); }
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
  onSessionCreated?: (session: RelaySessionMetadata) => void;
  onParticipantIdAssigned?: (id: number) => void;
}

export interface RelayUrlValidation {
  ok: boolean;
  normalizedUrl: string;
  error?: string;
  isLocal: boolean;
}

export function validateRelayUrl(input: string): RelayUrlValidation {
  const normalizedUrl = input.trim();

  if (!normalizedUrl) {
    return {
      ok: false,
      normalizedUrl,
      error: "Relay URL cannot be empty.",
      isLocal: false,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    return {
      ok: false,
      normalizedUrl,
      error: "Relay URL must be a valid ws:// or wss:// endpoint.",
      isLocal: false,
    };
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return {
      ok: false,
      normalizedUrl,
      error: "Relay URL must start with ws:// or wss://.",
      isLocal: false,
    };
  }

  const isLocal = LOCAL_RELAY_HOSTS.has(parsed.hostname);
  if (isLocal && parsed.pathname === "/relay" && parsed.port !== "8765") {
    parsed.port = "8765";
  }

  if (parsed.protocol === "ws:" && !isLocal) {
    return {
      ok: false,
      normalizedUrl,
      error: "Use wss:// for non-local relay endpoints.",
      isLocal,
    };
  }

  return {
    ok: true,
    normalizedUrl: parsed.toString(),
    isLocal,
  };
}

export async function probeRelayAvailability(
  url: string,
  timeoutMs: number = 2000,
): Promise<boolean> {
  const validation = validateRelayUrl(url);
  if (!validation.ok) return false;

  try {
    const ws = new WebSocket(validation.normalizedUrl);
    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve(false);
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timeout);
        ws.close();
        resolve(true);
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        resolve(false);
      };
    });
  } catch {
    return false;
  }
}

export function resolveRelayUrl(input?: string | null): string {
  const validation = validateRelayUrl((input ?? "").trim() || DEFAULT_RELAY_URL);
  if (!validation.ok) {
    throw new Error(validation.error ?? "Invalid relay URL.");
  }
  return validation.normalizedUrl;
}

export function isManagedRelayUrl(input: string): boolean {
  const candidate = validateRelayUrl(input);
  const managed = validateRelayUrl(DEFAULT_RELAY_URL);
  return candidate.ok && managed.ok && candidate.normalizedUrl === managed.normalizedUrl;
}

export function getRelayDisplayLabel(input: string): string {
  const validation = validateRelayUrl(input);
  if (!validation.ok) {
    return input;
  }

  if (isManagedRelayUrl(validation.normalizedUrl)) {
    return validation.isLocal ? "Local development relay" : "Vaulkyrie Relay";
  }

  return validation.normalizedUrl.replace(/^wss?:\/\//, "");
}

export function createRelay(opts: CreateRelayOptions): RelayAdapter {
  if (opts.mode === "local") {
    const events: RelayEvents = { ...opts.events };
    if (opts.onParticipantIdAssigned) {
      events.onParticipantIdAssigned = opts.onParticipantIdAssigned;
    }
    return new LocalRelayAdapter({
      sessionId: opts.sessionId ?? generateSessionCode(),
      participantId: opts.participantId,
      isCoordinator: opts.isCoordinator,
      deviceName: opts.deviceName,
      events,
    });
  }

  return new RemoteRelayAdapter({
    relayUrl: resolveRelayUrl(opts.relayUrl),
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
export const DEFAULT_RELAY_URL =
  import.meta.env.VITE_RELAY_URL?.trim() || inferHostedRelayUrl() || "ws://localhost:8765";
