/**
 * Vaulkyrie FROST service — wraps the WASM module for browser DKG and signing.
 *
 * This module lazily initializes the WASM binary and provides typed wrappers
 * around the raw wasm-bindgen exports. It handles:
 *  - Async WASM initialization
 *  - JSON serialization/deserialization to typed interfaces
 *  - A local single-device DKG flow (all participants in one browser for demo)
 *  - Individual round calls for multi-device flows
 */

import type {
  DkgRound1Result,
  DkgRound2Result,
  DkgRound3Result,
  SigningRound1Result,
  SigningRound2Result,
  AggregateResult,
  FullDkgResult,
  ParticipantDkgState,
} from "./types";

// Lazy WASM module reference
let wasmModule: typeof import("@/wasm/vaulkyrie-frost-wasm/vaulkyrie_frost_wasm") | null = null;
let initPromise: Promise<void> | null = null;

/** Ensure the WASM module is loaded exactly once */
async function ensureWasm() {
  if (wasmModule) return wasmModule;
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import("@/wasm/vaulkyrie-frost-wasm/vaulkyrie_frost_wasm");
      wasmModule = mod;
    })();
  }
  await initPromise;
  return wasmModule!;
}

// ---------------------------------------------------------------------------
// Individual round wrappers (for multi-device relay flow)
// ---------------------------------------------------------------------------

export async function dkgRound1(
  participantId: number,
  maxSigners: number,
  minSigners: number,
): Promise<DkgRound1Result> {
  const wasm = await ensureWasm();
  const json = wasm.dkg_round1(participantId, maxSigners, minSigners);
  return JSON.parse(json) as DkgRound1Result;
}

export async function dkgRound2(
  participantId: number,
  secretPackageJson: string,
  round1PackagesJson: string,
): Promise<DkgRound2Result> {
  const wasm = await ensureWasm();
  const json = wasm.dkg_round2(participantId, secretPackageJson, round1PackagesJson);
  return JSON.parse(json) as DkgRound2Result;
}

export async function dkgRound3(
  participantId: number,
  secretPackageJson: string,
  round1PackagesJson: string,
  round2PackagesJson: string,
): Promise<DkgRound3Result> {
  const wasm = await ensureWasm();
  const json = wasm.dkg_round3(participantId, secretPackageJson, round1PackagesJson, round2PackagesJson);
  return JSON.parse(json) as DkgRound3Result;
}

export async function signingRound1(
  participantId: number,
  keyPackageJson: string,
): Promise<SigningRound1Result> {
  const wasm = await ensureWasm();
  const json = wasm.signing_round1(participantId, keyPackageJson);
  return JSON.parse(json) as SigningRound1Result;
}

export async function signingRound2(
  participantId: number,
  noncesJson: string,
  keyPackageJson: string,
  message: Uint8Array,
  commitmentsJson: string,
): Promise<SigningRound2Result> {
  const wasm = await ensureWasm();
  const json = wasm.signing_round2(participantId, noncesJson, keyPackageJson, message, commitmentsJson);
  return JSON.parse(json) as SigningRound2Result;
}

export async function aggregateSignature(
  message: Uint8Array,
  commitmentsJson: string,
  signatureSharesJson: string,
  publicKeyPackageJson: string,
): Promise<AggregateResult> {
  const wasm = await ensureWasm();
  const json = wasm.aggregate_signature(message, commitmentsJson, signatureSharesJson, publicKeyPackageJson);
  return JSON.parse(json) as AggregateResult;
}

export async function verifySignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const wasm = await ensureWasm();
  return wasm.verify_signature(publicKey, message, signature);
}

// ---------------------------------------------------------------------------
// Local single-device DKG (all participants simulated in one browser)
// ---------------------------------------------------------------------------

export interface LocalDkgProgress {
  phase: "round1" | "round2" | "round3" | "complete";
  progress: number;   // 0-100
  message: string;
}

/**
 * Run a complete DKG ceremony locally — all participants in one browser.
 * This is the demo/testing flow. For real multi-device, use the relay.
 *
 * The WASM functions accept/return JSON strings. Internally frost types
 * are serialized as Vec<u8> → number[]. We pass these as stringified JSON
 * back into subsequent WASM rounds.
 *
 * @param minSigners  Signing threshold (e.g. 2)
 * @param maxSigners  Total participants (e.g. 3)
 * @param onProgress  Optional callback for UI progress updates
 * @returns Normalized DKG result with hex group key + JSON key packages
 */
export async function runLocalDkg(
  minSigners: number,
  maxSigners: number,
  onProgress?: (p: LocalDkgProgress) => void,
): Promise<FullDkgResult> {
  const wasm = await ensureWasm();

  onProgress?.({ phase: "round1", progress: 5, message: "Generating commitments…" });

  // ---- Round 1: each participant generates commitments ----
  const participants: ParticipantDkgState[] = [];
  const round1Packages: Record<number, number[]> = {};

  for (let i = 1; i <= maxSigners; i++) {
    const r1Json = wasm.dkg_round1(i, maxSigners, minSigners);
    const r1: DkgRound1Result = JSON.parse(r1Json);
    participants.push({
      id: i,
      round1Secret: r1.secret_package,
      round1Package: r1.package,
    });
    round1Packages[i] = r1.package;
  }

  onProgress?.({ phase: "round1", progress: 33, message: "Commitments generated" });

  // Small yield so the UI can repaint
  await new Promise((r) => setTimeout(r, 50));

  onProgress?.({ phase: "round2", progress: 40, message: "Exchanging packages…" });

  // ---- Round 2: each participant processes others' round 1 packages ----
  for (const p of participants) {
    // Build the map of OTHER participants' round 1 packages (exclude self)
    const otherR1: Record<number, number[]> = {};
    for (const [idStr, pkg] of Object.entries(round1Packages)) {
      const pid = Number(idStr);
      if (pid !== p.id) otherR1[pid] = pkg;
    }

    // WASM expects JSON strings — stringify before passing
    const r2Json = wasm.dkg_round2(
      p.id,
      JSON.stringify(p.round1Secret),
      JSON.stringify(otherR1),
    );
    const r2: DkgRound2Result = JSON.parse(r2Json);
    p.round2Secret = r2.secret_package;
    p.round2Packages = r2.packages;
  }

  onProgress?.({ phase: "round2", progress: 66, message: "Packages exchanged" });

  await new Promise((r) => setTimeout(r, 50));

  onProgress?.({ phase: "round3", progress: 70, message: "Computing group key…" });

  // ---- Round 3: each participant finalizes ----
  const keyPackages: Record<number, string> = {};
  let publicKeyPackage = "";
  let groupPublicKeyHex = "";

  for (const p of participants) {
    // Other participants' round 1 packages (exclude self)
    const otherR1: Record<number, number[]> = {};
    for (const [idStr, pkg] of Object.entries(round1Packages)) {
      const pid = Number(idStr);
      if (pid !== p.id) otherR1[pid] = pkg;
    }

    // Round 2 packages addressed TO this participant FROM others
    const r2ForMe: Record<number, number[]> = {};
    for (const other of participants) {
      if (other.id !== p.id && other.round2Packages) {
        const pkgForMe = other.round2Packages[p.id];
        if (pkgForMe) r2ForMe[other.id] = pkgForMe;
      }
    }

    // WASM expects JSON strings for all structured data
    const r3Json = wasm.dkg_round3(
      p.id,
      JSON.stringify(p.round2Secret),
      JSON.stringify(otherR1),
      JSON.stringify(r2ForMe),
    );
    const r3: DkgRound3Result = JSON.parse(r3Json);

    p.keyPackage = r3.key_package;
    p.publicKeyPackage = r3.public_key_package;

    // Store key packages as JSON strings for later signing
    keyPackages[p.id] = JSON.stringify(r3.key_package);
    publicKeyPackage = JSON.stringify(r3.public_key_package);
    groupPublicKeyHex = bytesToHex(new Uint8Array(r3.group_public_key));
  }

  onProgress?.({ phase: "complete", progress: 100, message: "DKG complete" });

  return {
    groupPublicKeyHex,
    keyPackages,
    publicKeyPackage,
  };
}

// ---------------------------------------------------------------------------
// Local threshold signing (demo/testing — real flow uses relay)
// ---------------------------------------------------------------------------

/**
 * Sign a message using `minSigners` participants locally.
 *
 * @param message         Raw bytes to sign
 * @param keyPackages     Map of participant_id → key_package JSON string
 * @param publicKeyPkg    The shared public key package JSON string
 * @param signerIds       Which participants will sign (must have >= threshold)
 * @returns 64-byte Ed25519 signature as hex
 */
export async function signLocal(
  message: Uint8Array,
  keyPackages: Record<number, string>,
  publicKeyPkg: string,
  signerIds: number[],
): Promise<{ signatureHex: string; publicKeyHex: string; verified: boolean }> {
  const wasm = await ensureWasm();

  // Round 1: generate nonces + commitments
  const noncesMap: Record<number, number[]> = {};
  const commitmentsMap: Record<number, number[]> = {};

  for (const pid of signerIds) {
    const r1Json = wasm.signing_round1(pid, keyPackages[pid]);
    const r1: SigningRound1Result = JSON.parse(r1Json);
    noncesMap[pid] = r1.nonces;
    commitmentsMap[pid] = r1.commitments;
  }

  // Round 2: produce signature shares
  const sharesMap: Record<number, number[]> = {};

  for (const pid of signerIds) {
    const r2Json = wasm.signing_round2(
      pid,
      JSON.stringify(noncesMap[pid]),
      keyPackages[pid],
      message,
      JSON.stringify(commitmentsMap),
    );
    const r2: SigningRound2Result = JSON.parse(r2Json);
    sharesMap[pid] = r2.signature_share;
  }

  // Aggregate
  const aggJson = wasm.aggregate_signature(
    message,
    JSON.stringify(commitmentsMap),
    JSON.stringify(sharesMap),
    publicKeyPkg,
  );
  const agg: AggregateResult = JSON.parse(aggJson);

  return {
    signatureHex: bytesToHex(new Uint8Array(agg.signature)),
    publicKeyHex: bytesToHex(new Uint8Array(agg.group_public_key)),
    verified: agg.verified,
  };
}

/** Convert hex string to Uint8Array */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Convert Uint8Array to hex string */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
