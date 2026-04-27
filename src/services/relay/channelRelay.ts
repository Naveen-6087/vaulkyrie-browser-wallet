/**
 * BroadcastChannel relay for cross-tab DKG and signing ceremonies.
 *
 * Each browser tab acts as an independent FROST participant. The relay
 * uses the BroadcastChannel API (same-origin cross-tab messaging) to
 * exchange DKG round data without a server.
 *
 * Protocol:
 *   1. Creator tab generates a session ID and shows QR/code
 *   2. Joiner tabs enter the code → join the same BroadcastChannel
 *   3. Coordinator broadcasts "start-dkg" when all participants are ready
 *   4. Each tab runs WASM FROST rounds and broadcasts results via channel
 *   5. Each tab collects others' data and progresses through rounds
 */

// ── Message types ────────────────────────────────────────────────────

export const RelayMessageType = {
  /** Announce presence on the channel */
  Join: "join",
  /** Acknowledge a join */
  JoinAck: "join-ack",
  /** Participant is leaving */
  Leave: "leave",
  /** Heartbeat to confirm presence */
  Ping: "ping",
  /** Coordinator signals DKG start */
  StartDkg: "start-dkg",
  /** DKG round 1 broadcast package */
  DkgRound1: "dkg-round1",
  /** DKG round 2 directed packages */
  DkgRound2: "dkg-round2",
  /** DKG round 3 result (group key confirmation) */
  DkgRound3Done: "dkg-round3-done",
  /** Signing round 1 commitments */
  SignRequest: "sign-request",
  /** Signing round 1 commitments */
  SignRound1: "sign-round1",
  /** Signing round 2 signature share */
  SignRound2: "sign-round2",
  /** Aggregated signature result */
  SignComplete: "sign-complete",
  /** Error from a participant */
  Error: "error",
  /** Coordinator assigns participant ID to a joiner */
  IdAssign: "id-assign",
} as const;

export type RelayMessageType = (typeof RelayMessageType)[keyof typeof RelayMessageType];

export interface RelayMessage {
  type: RelayMessageType;
  senderId: string;
  participantId: number;
  sessionId: string;
  timestamp: number;
  payload: unknown;
}

// ── Join payload ─────────────────────────────────────────────────────

export interface JoinPayload {
  deviceName: string;
  deviceType: "browser" | "mobile" | "desktop";
}

export interface SignRequestPayload {
  requestId: string;
  message: number[];
  signerIds: number[];
  amount: number;
  token: string;
  recipient: string;
  initiator: string;
  network: string;
  createdAt: number;
  purpose?: "send" | "bootstrap" | "policy";
  summary?: string;
  estimatedFeeLamports?: number | null;
  computeUnitsConsumed?: number | null;
  requiredSignerCount?: number;
  writableAccountCount?: number;
}

// ── Participant state ────────────────────────────────────────────────

export interface RelayParticipant {
  senderId: string;
  participantId: number;
  deviceName: string;
  deviceType: "browser" | "mobile" | "desktop";
  joinedAt: number;
  lastSeen: number;
}

// ── Event callbacks ──────────────────────────────────────────────────

export interface RelayEvents {
  onParticipantJoined?: (participant: RelayParticipant) => void;
  onParticipantLeft?: (senderId: string) => void;
  onSignRequest?: (fromId: number, request: SignRequestPayload) => void;
  onDkgRound1?: (fromId: number, pkg: number[]) => void;
  onDkgRound2?: (fromId: number, packages: Record<number, number[]>) => void;
  onDkgRound3Done?: (fromId: number, groupKeyHex: string) => void;
  onSignRound1?: (fromId: number, commitments: number[]) => void;
  onSignRound2?: (fromId: number, share: number[]) => void;
  onSignComplete?: (signatureHex: string, verified: boolean) => void;
  onStartDkg?: (threshold: number, participants: number) => void;
  onError?: (fromId: number, error: string) => void;
  onParticipantIdAssigned?: (id: number) => void;
}

// ── Channel Relay class ──────────────────────────────────────────────

const CHANNEL_PREFIX = "vaulkyrie-dkg-";
const HEARTBEAT_INTERVAL = 3000;
const STALE_TIMEOUT = 10000;

export class ChannelRelay {
  private channel: BroadcastChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  readonly sessionId: string;
  readonly senderId: string;
  participantId: number;
  readonly isCoordinator: boolean;

  private participants = new Map<string, RelayParticipant>();
  private events: RelayEvents;
  private nextAssignableId = 2;

  constructor(opts: {
    sessionId: string;
    participantId: number;
    isCoordinator: boolean;
    deviceName: string;
    deviceType: "browser" | "mobile" | "desktop";
    events: RelayEvents;
  }) {
    this.sessionId = opts.sessionId;
    this.senderId = crypto.randomUUID();
    this.participantId = opts.participantId;
    this.isCoordinator = opts.isCoordinator;
    this.events = opts.events;

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

  /** Connect to the BroadcastChannel and start listening */
  connect(): void {
    if (this.channel) return;

    this.channel = new BroadcastChannel(CHANNEL_PREFIX + this.sessionId);
    this.channel.onmessage = (ev: MessageEvent<RelayMessage>) => {
      this.handleMessage(ev.data);
    };

    // Announce presence
    this.broadcast(RelayMessageType.Join, {
      deviceName: this.participants.get(this.senderId)!.deviceName,
      deviceType: this.participants.get(this.senderId)!.deviceType,
    } satisfies JoinPayload);

    // Heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.broadcast(RelayMessageType.Ping, null);
    }, HEARTBEAT_INTERVAL);

    // Stale participant check
    this.staleCheckTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, p] of this.participants) {
        if (id === this.senderId) continue;
        if (now - p.lastSeen > STALE_TIMEOUT) {
          this.participants.delete(id);
          this.events.onParticipantLeft?.(id);
        }
      }
    }, STALE_TIMEOUT / 2);
  }

  /** Disconnect and clean up */
  disconnect(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);
    this.heartbeatTimer = null;
    this.staleCheckTimer = null;

    if (this.channel) {
      this.broadcast(RelayMessageType.Leave, null);
      this.channel.close();
      this.channel = null;
    }
  }

  /** Get all connected participants (including self) */
  getParticipants(): RelayParticipant[] {
    return Array.from(this.participants.values());
  }

  /** Get participant count */
  get participantCount(): number {
    return this.participants.size;
  }

  // ── Broadcasting helpers ─────────────────────────────────────────

  broadcastDkgRound1(pkg: number[]): void {
    this.broadcast(RelayMessageType.DkgRound1, pkg);
  }

  broadcastDkgRound2(packages: Record<number, number[]>): void {
    this.broadcast(RelayMessageType.DkgRound2, packages);
  }

  broadcastDkgRound3Done(groupKeyHex: string): void {
    this.broadcast(RelayMessageType.DkgRound3Done, groupKeyHex);
  }

  broadcastSignRequest(request: SignRequestPayload): void {
    this.broadcast(RelayMessageType.SignRequest, request);
  }

  broadcastSignRound1(commitments: number[]): void {
    this.broadcast(RelayMessageType.SignRound1, commitments);
  }

  broadcastSignRound2(share: number[]): void {
    this.broadcast(RelayMessageType.SignRound2, share);
  }

  broadcastSignComplete(signatureHex: string, verified: boolean): void {
    this.broadcast(RelayMessageType.SignComplete, { signatureHex, verified });
  }

  broadcastStartDkg(threshold: number, participants: number): void {
    this.broadcast(RelayMessageType.StartDkg, { threshold, participants });
  }

  broadcastError(error: string): void {
    this.broadcast(RelayMessageType.Error, error);
  }

  // ── Internal ─────────────────────────────────────────────────────

  private broadcast(type: RelayMessageType, payload: unknown): void {
    if (!this.channel) return;

    const msg: RelayMessage = {
      type,
      senderId: this.senderId,
      participantId: this.participantId,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      payload,
    };

    this.channel.postMessage(msg);
  }

  private handleMessage(msg: RelayMessage): void {
    // Ignore own messages
    if (msg.senderId === this.senderId) return;
    // Ignore wrong session
    if (msg.sessionId !== this.sessionId) return;

    // Update last seen
    const existing = this.participants.get(msg.senderId);
    if (existing) {
      existing.lastSeen = Date.now();
    }

    switch (msg.type) {
      case RelayMessageType.Join: {
        const jp = msg.payload as JoinPayload;
        let assignedPid = msg.participantId;
        if (this.isCoordinator && msg.participantId === 0) {
          assignedPid = this.nextAssignableId++;
          this.broadcast(RelayMessageType.IdAssign, {
            targetSenderId: msg.senderId,
            assignedId: assignedPid,
          });
        }
        const participant: RelayParticipant = {
          senderId: msg.senderId,
          participantId: assignedPid,
          deviceName: jp.deviceName,
          deviceType: jp.deviceType,
          joinedAt: msg.timestamp,
          lastSeen: Date.now(),
        };
        this.participants.set(msg.senderId, participant);
        this.events.onParticipantJoined?.(participant);

        // Acknowledge so the joiner knows about us
        this.broadcast(RelayMessageType.JoinAck, {
          deviceName: this.participants.get(this.senderId)!.deviceName,
          deviceType: this.participants.get(this.senderId)!.deviceType,
        } satisfies JoinPayload);
        break;
      }

      case RelayMessageType.JoinAck: {
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

      case RelayMessageType.Leave:
        this.participants.delete(msg.senderId);
        this.events.onParticipantLeft?.(msg.senderId);
        break;

      case RelayMessageType.Ping:
        // Just updates lastSeen (handled above)
        break;

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

      case RelayMessageType.IdAssign: {
        const idPayload = msg.payload as { targetSenderId: string; assignedId: number };
        if (idPayload.targetSenderId === this.senderId) {
          this.participantId = idPayload.assignedId;
          const self = this.participants.get(this.senderId);
          if (self) self.participantId = idPayload.assignedId;
          this.events.onParticipantIdAssigned?.(idPayload.assignedId);
        }
        break;
      }
    }
  }
}

// ── Session code helpers ─────────────────────────────────────────────

/** Generate a 6-character session code for manual entry */
export function generateSessionCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/** Build a QR payload for device scanning */
export function buildQrPayload(sessionId: string, threshold: number, participants: number): string {
  return JSON.stringify({
    protocol: "vaulkyrie-dkg",
    version: 1,
    session: sessionId,
    threshold,
    participants,
    expires: Date.now() + 300_000, // 5 min
  });
}
