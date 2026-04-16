/**
 * Multi-device DKG orchestrator — coordinates 3-round FROST DKG across
 * multiple devices via a relay (WebSocket or BroadcastChannel).
 *
 * Each device runs its own WASM FROST rounds locally. The orchestrator
 * collects broadcast data from all other participants, waits until a
 * round is complete, then advances to the next round.
 *
 * Flow:
 *   1. Coordinator broadcasts "start-dkg" → all participants begin round 1
 *   2. Each participant: dkg_round1() → broadcast round1 package
 *   3. Wait for all round1 packages → dkg_round2() → broadcast round2 packages
 *   4. Wait for all round2 packages → dkg_round3() → broadcast group key confirmation
 *   5. Validate all participants agree on the same group public key → done
 */

import type { RelayAdapter } from "../relay/relayAdapter";
import { dkgRound1, dkgRound2, dkgRound3, bytesToHex } from "../frost/frostService";
import type { DkgRound1Result, DkgRound2Result, DkgRound3Result } from "../frost/types";

// ── Types ────────────────────────────────────────────────────────────

export interface DkgOrchestratorResult {
  groupPublicKeyHex: string;
  keyPackageJson: string;       // This participant's secret key package (JSON)
  publicKeyPackageJson: string; // Shared group verifying key package (JSON)
  participantId: number;
  threshold: number;
  totalParticipants: number;
}

export interface DkgOrchestratorProgress {
  phase: "waiting" | "round1" | "round2" | "round3" | "validating" | "complete" | "error";
  progress: number;
  message: string;
  participantsReady?: number;
  participantsTotal?: number;
}

export type DkgProgressCallback = (p: DkgOrchestratorProgress) => void;

// ── Orchestrator ─────────────────────────────────────────────────────

export class DkgOrchestrator {
  private relay: RelayAdapter;
  private participantId: number;
  private threshold: number;
  private totalParticipants: number;
  private onProgress: DkgProgressCallback;

  // Collected data from other participants
  private round1Packages = new Map<number, number[]>();
  private round2Packages = new Map<number, Record<number, number[]>>();
  private round3Confirmations = new Map<number, string>();

  // Local state from our own rounds
  private myRound1Result: DkgRound1Result | null = null;
  private myRound2Result: DkgRound2Result | null = null;
  private myRound3Result: DkgRound3Result | null = null;

  // Promise resolvers for waiting on round data
  private round1Resolve: (() => void) | null = null;
  private round2Resolve: (() => void) | null = null;
  private round3Resolve: (() => void) | null = null;

  // Track if DKG has been started (only start once)
  private started = false;

  constructor(opts: {
    relay: RelayAdapter;
    participantId: number;
    threshold: number;
    totalParticipants: number;
    onProgress: DkgProgressCallback;
  }) {
    this.relay = opts.relay;
    this.participantId = opts.participantId;
    this.threshold = opts.threshold;
    this.totalParticipants = opts.totalParticipants;
    this.onProgress = opts.onProgress;
  }

  /**
   * Run the complete 3-round DKG as this participant.
   * The relay must already be connected and the session joined.
   */
  async run(): Promise<DkgOrchestratorResult> {
    if (this.started) throw new Error("DKG already started");
    this.started = true;

    // Wire up relay event handlers
    this.attachRelayHandlers();

    // If coordinator, broadcast start signal
    if (this.relay.isCoordinator) {
      this.relay.broadcastStartDkg(this.threshold, this.totalParticipants);
    }

    try {
      // ── Round 1 ──
      this.onProgress({
        phase: "round1",
        progress: 5,
        message: "Generating commitments…",
      });

      this.myRound1Result = await dkgRound1(
        this.participantId,
        this.totalParticipants,
        this.threshold,
      );

      // Include our own round1 package in the collection
      this.round1Packages.set(this.participantId, this.myRound1Result.package);

      // Broadcast our round1 package to all others
      this.relay.broadcastDkgRound1(this.myRound1Result.package);

      this.onProgress({
        phase: "round1",
        progress: 15,
        message: "Waiting for other participants…",
        participantsReady: this.round1Packages.size,
        participantsTotal: this.totalParticipants,
      });

      // Wait for all participants' round1 packages
      await this.waitForRound1();

      this.onProgress({
        phase: "round1",
        progress: 33,
        message: "All commitments received",
      });

      // ── Round 2 ──
      this.onProgress({
        phase: "round2",
        progress: 40,
        message: "Computing key shares…",
      });

      // Build other participants' round1 packages (exclude self)
      const otherR1: Record<number, number[]> = {};
      for (const [pid, pkg] of this.round1Packages) {
        if (pid !== this.participantId) otherR1[pid] = pkg;
      }

      this.myRound2Result = await dkgRound2(
        this.participantId,
        JSON.stringify(this.myRound1Result.secret_package),
        JSON.stringify(otherR1),
      );

      // Include our own round2 packages in the collection
      this.round2Packages.set(this.participantId, this.myRound2Result.packages);

      // Broadcast our round2 packages
      this.relay.broadcastDkgRound2(this.myRound2Result.packages);

      this.onProgress({
        phase: "round2",
        progress: 50,
        message: "Waiting for key shares…",
        participantsReady: this.round2Packages.size,
        participantsTotal: this.totalParticipants,
      });

      // Wait for all participants' round2 packages
      await this.waitForRound2();

      this.onProgress({
        phase: "round2",
        progress: 66,
        message: "All key shares received",
      });

      // ── Round 3 ──
      this.onProgress({
        phase: "round3",
        progress: 70,
        message: "Computing group key…",
      });

      // Round 2 packages addressed TO us FROM others
      const r2ForMe: Record<number, number[]> = {};
      for (const [fromId, packages] of this.round2Packages) {
        if (fromId !== this.participantId) {
          const pkgForMe = packages[this.participantId];
          if (pkgForMe) r2ForMe[fromId] = pkgForMe;
        }
      }

      // Other participants' round1 packages (same as before)
      this.myRound3Result = await dkgRound3(
        this.participantId,
        JSON.stringify(this.myRound2Result.secret_package),
        JSON.stringify(otherR1),
        JSON.stringify(r2ForMe),
      );

      const groupKeyHex = bytesToHex(new Uint8Array(this.myRound3Result.group_public_key));

      // Include our own confirmation
      this.round3Confirmations.set(this.participantId, groupKeyHex);

      // Broadcast our group key confirmation
      this.relay.broadcastDkgRound3Done(groupKeyHex);

      this.onProgress({
        phase: "round3",
        progress: 85,
        message: "Validating group key…",
        participantsReady: this.round3Confirmations.size,
        participantsTotal: this.totalParticipants,
      });

      // Wait for all participants' confirmations
      await this.waitForRound3();

      // ── Validation ──
      this.onProgress({
        phase: "validating",
        progress: 95,
        message: "Verifying all participants agree…",
      });

      // Verify all participants computed the same group public key
      for (const [pid, key] of this.round3Confirmations) {
        if (key !== groupKeyHex) {
          throw new Error(
            `Group key mismatch: participant ${pid} computed ${key.slice(0, 16)}... ` +
            `but we computed ${groupKeyHex.slice(0, 16)}...`
          );
        }
      }

      this.onProgress({
        phase: "complete",
        progress: 100,
        message: "DKG ceremony complete!",
      });

      return {
        groupPublicKeyHex: groupKeyHex,
        keyPackageJson: JSON.stringify(this.myRound3Result.key_package),
        publicKeyPackageJson: JSON.stringify(this.myRound3Result.public_key_package),
        participantId: this.participantId,
        threshold: this.threshold,
        totalParticipants: this.totalParticipants,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.relay.broadcastError(message);
      this.onProgress({
        phase: "error",
        progress: 0,
        message,
      });
      throw err;
    }
  }

  // ── Waiting helpers ─────────────────────────────────────────────

  private waitForRound1(): Promise<void> {
    if (this.round1Packages.size >= this.totalParticipants) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.round1Resolve = resolve;
    });
  }

  private waitForRound2(): Promise<void> {
    if (this.round2Packages.size >= this.totalParticipants) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.round2Resolve = resolve;
    });
  }

  private waitForRound3(): Promise<void> {
    if (this.round3Confirmations.size >= this.totalParticipants) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.round3Resolve = resolve;
    });
  }

  // ── Relay event handlers ────────────────────────────────────────

  private attachRelayHandlers(): void {
    const origR1 = this.relay["events"]?.onDkgRound1;
    const origR2 = this.relay["events"]?.onDkgRound2;
    const origR3 = this.relay["events"]?.onDkgRound3Done;

    // We intercept events by replacing the relay's event object
    // (the relay adapter stores events as a field we can access via the
    // broadcast handlers — but instead we use the relay's onDkg* events
    // passed during construction. The caller should wire these through.)
    //
    // Since the relay adapter is created with events callbacks, we just
    // need those callbacks to feed into our collection maps. The caller
    // must pass our handler methods as the events when creating the relay.

    void origR1;
    void origR2;
    void origR3;
  }

  /** Call this from the relay's onDkgRound1 event */
  handleDkgRound1(fromId: number, pkg: number[]): void {
    this.round1Packages.set(fromId, pkg);
    this.onProgress({
      phase: "round1",
      progress: 10 + (this.round1Packages.size / this.totalParticipants) * 23,
      message: `Received commitments (${this.round1Packages.size}/${this.totalParticipants})`,
      participantsReady: this.round1Packages.size,
      participantsTotal: this.totalParticipants,
    });

    if (this.round1Packages.size >= this.totalParticipants && this.round1Resolve) {
      this.round1Resolve();
      this.round1Resolve = null;
    }
  }

  /** Call this from the relay's onDkgRound2 event */
  handleDkgRound2(fromId: number, packages: Record<number, number[]>): void {
    this.round2Packages.set(fromId, packages);
    this.onProgress({
      phase: "round2",
      progress: 40 + (this.round2Packages.size / this.totalParticipants) * 26,
      message: `Received key shares (${this.round2Packages.size}/${this.totalParticipants})`,
      participantsReady: this.round2Packages.size,
      participantsTotal: this.totalParticipants,
    });

    if (this.round2Packages.size >= this.totalParticipants && this.round2Resolve) {
      this.round2Resolve();
      this.round2Resolve = null;
    }
  }

  /** Call this from the relay's onDkgRound3Done event */
  handleDkgRound3Done(fromId: number, groupKeyHex: string): void {
    this.round3Confirmations.set(fromId, groupKeyHex);
    this.onProgress({
      phase: "round3",
      progress: 75 + (this.round3Confirmations.size / this.totalParticipants) * 20,
      message: `Verified keys (${this.round3Confirmations.size}/${this.totalParticipants})`,
      participantsReady: this.round3Confirmations.size,
      participantsTotal: this.totalParticipants,
    });

    if (this.round3Confirmations.size >= this.totalParticipants && this.round3Resolve) {
      this.round3Resolve();
      this.round3Resolve = null;
    }
  }
}
