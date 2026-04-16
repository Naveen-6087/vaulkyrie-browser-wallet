/**
 * Multi-device signing orchestrator — coordinates 2-round FROST threshold
 * signing across multiple devices via a relay.
 *
 * Flow:
 *   1. Coordinator broadcasts a "sign request" with the message to sign
 *   2. Each signer: signing_round1() → broadcast commitments
 *   3. Wait for all commitments → signing_round2() → broadcast signature share
 *   4. Coordinator aggregates shares → broadcast final signature
 *   5. All participants verify the aggregated signature
 */

import type { RelayAdapter } from "../relay/relayAdapter";
import {
  signingRound1,
  signingRound2,
  aggregateSignature,
  verifySignature,
  bytesToHex,
  hexToBytes,
} from "../frost/frostService";

// ── Types ────────────────────────────────────────────────────────────

export interface SigningOrchestratorResult {
  signatureHex: string;
  publicKeyHex: string;
  verified: boolean;
}

export interface SigningProgress {
  phase: "collecting-commitments" | "computing-share" | "aggregating" | "verifying" | "complete" | "error";
  progress: number;
  message: string;
}

export type SigningProgressCallback = (p: SigningProgress) => void;

// ── Orchestrator ─────────────────────────────────────────────────────

export class SigningOrchestrator {
  private relay: RelayAdapter;
  private participantId: number;
  private keyPackageJson: string;
  private publicKeyPackageJson: string;
  private message: Uint8Array;
  private signerIds: number[];
  private onProgress: SigningProgressCallback;

  // Collected data
  private commitments = new Map<number, number[]>();
  private signatureShares = new Map<number, number[]>();

  // Promise resolvers
  private commitmentsResolve: (() => void) | null = null;
  private sharesResolve: (() => void) | null = null;

  // Local round state
  private myNonces: number[] | null = null;

  constructor(opts: {
    relay: RelayAdapter;
    participantId: number;
    keyPackageJson: string;
    publicKeyPackageJson: string;
    message: Uint8Array;
    signerIds: number[];
    onProgress: SigningProgressCallback;
  }) {
    this.relay = opts.relay;
    this.participantId = opts.participantId;
    this.keyPackageJson = opts.keyPackageJson;
    this.publicKeyPackageJson = opts.publicKeyPackageJson;
    this.message = opts.message;
    this.signerIds = opts.signerIds;
    this.onProgress = opts.onProgress;
  }

  /**
   * Run the 2-round signing protocol as this participant.
   */
  async run(): Promise<SigningOrchestratorResult> {
    const requiredSigners = this.signerIds.length;

    try {
      // ── Round 1: Generate commitments ──
      this.onProgress({
        phase: "collecting-commitments",
        progress: 10,
        message: "Generating signing commitments…",
      });

      const r1 = await signingRound1(this.participantId, this.keyPackageJson);
      this.myNonces = r1.nonces;

      // Store our own commitments
      this.commitments.set(this.participantId, r1.commitments);

      // Broadcast commitments
      this.relay.broadcastSignRound1(r1.commitments);

      this.onProgress({
        phase: "collecting-commitments",
        progress: 20,
        message: `Waiting for commitments (${this.commitments.size}/${requiredSigners})`,
      });

      // Wait for all signers' commitments
      await this.waitForCommitments(requiredSigners);

      // ── Round 2: Compute signature share ──
      this.onProgress({
        phase: "computing-share",
        progress: 50,
        message: "Computing signature share…",
      });

      // Build commitments map for all signers
      const commitmentsMap: Record<number, number[]> = {};
      for (const [pid, c] of this.commitments) {
        commitmentsMap[pid] = c;
      }

      const r2 = await signingRound2(
        this.participantId,
        JSON.stringify(this.myNonces),
        this.keyPackageJson,
        this.message,
        JSON.stringify(commitmentsMap),
      );

      // Store our share
      this.signatureShares.set(this.participantId, r2.signature_share);

      // Broadcast share
      this.relay.broadcastSignRound2(r2.signature_share);

      this.onProgress({
        phase: "computing-share",
        progress: 60,
        message: `Waiting for shares (${this.signatureShares.size}/${requiredSigners})`,
      });

      // Wait for all shares
      await this.waitForShares(requiredSigners);

      // ── Aggregation (coordinator only, but all can verify) ──
      this.onProgress({
        phase: "aggregating",
        progress: 80,
        message: "Aggregating signature…",
      });

      const sharesMap: Record<number, number[]> = {};
      for (const [pid, s] of this.signatureShares) {
        sharesMap[pid] = s;
      }

      const commitmentsMapFull: Record<number, number[]> = {};
      for (const [pid, c] of this.commitments) {
        commitmentsMapFull[pid] = c;
      }

      const agg = await aggregateSignature(
        this.message,
        JSON.stringify(commitmentsMapFull),
        JSON.stringify(sharesMap),
        this.publicKeyPackageJson,
      );

      const signatureHex = bytesToHex(new Uint8Array(agg.signature));
      const publicKeyHex = bytesToHex(new Uint8Array(agg.group_public_key));

      // ── Verify ──
      this.onProgress({
        phase: "verifying",
        progress: 90,
        message: "Verifying signature…",
      });

      const verified = await verifySignature(
        hexToBytes(publicKeyHex),
        this.message,
        hexToBytes(signatureHex),
      );

      // Broadcast result if coordinator
      if (this.relay.isCoordinator) {
        this.relay.broadcastSignComplete(signatureHex, verified);
      }

      this.onProgress({
        phase: "complete",
        progress: 100,
        message: verified ? "Signature verified!" : "Signature verification failed",
      });

      return { signatureHex, publicKeyHex, verified };
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

  private waitForCommitments(count: number): Promise<void> {
    if (this.commitments.size >= count) return Promise.resolve();
    return new Promise((resolve) => { this.commitmentsResolve = resolve; });
  }

  private waitForShares(count: number): Promise<void> {
    if (this.signatureShares.size >= count) return Promise.resolve();
    return new Promise((resolve) => { this.sharesResolve = resolve; });
  }

  // ── Relay event handlers (call from relay events) ──────────────

  handleSignRound1(fromId: number, commitments: number[]): void {
    this.commitments.set(fromId, commitments);
    const total = this.signerIds.length;
    this.onProgress({
      phase: "collecting-commitments",
      progress: 20 + (this.commitments.size / total) * 30,
      message: `Received commitments (${this.commitments.size}/${total})`,
    });
    if (this.commitments.size >= total && this.commitmentsResolve) {
      this.commitmentsResolve();
      this.commitmentsResolve = null;
    }
  }

  handleSignRound2(fromId: number, share: number[]): void {
    this.signatureShares.set(fromId, share);
    const total = this.signerIds.length;
    this.onProgress({
      phase: "computing-share",
      progress: 60 + (this.signatureShares.size / total) * 20,
      message: `Received shares (${this.signatureShares.size}/${total})`,
    });
    if (this.signatureShares.size >= total && this.sharesResolve) {
      this.sharesResolve();
      this.sharesResolve = null;
    }
  }
}
