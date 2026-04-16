/**
 * Vaulkyrie FROST DKG/signing type definitions.
 *
 * These mirror the actual JSON structures returned by the WASM module.
 * WASM serializes frost types via serde_json — Vec<u8> becomes number[]
 * and all struct field names match the Rust struct exactly.
 */

/** DKG round 1 output for one participant */
export interface DkgRound1Result {
  participant_id: number;
  secret_package: number[];   // serde_json Vec<u8> → number[]
  package: number[];          // broadcast to all other participants
}

/** DKG round 2 output for one participant */
export interface DkgRound2Result {
  participant_id: number;
  secret_package: number[];   // kept locally for round 3
  packages: Record<number, number[]>; // recipient_id → package bytes
}

/** DKG round 3 (finalization) output */
export interface DkgRound3Result {
  participant_id: number;
  key_package: number[];          // secret share — never leaves device
  public_key_package: number[];   // group verifying key + share commits
  group_public_key: number[];     // 32-byte verifying key
}

/** Signing round 1 output */
export interface SigningRound1Result {
  participant_id: number;
  nonces: number[];           // kept locally
  commitments: number[];      // broadcast to signing group
}

/** Signing round 2 output */
export interface SigningRound2Result {
  participant_id: number;
  signature_share: number[];  // sent to aggregator
}

/** Aggregate signature result */
export interface AggregateResult {
  signature: number[];        // 64-byte Ed25519 signature
  group_public_key: number[]; // 32-byte verifying key
  verified: boolean;          // ed25519-dalek verification result
}

/** Normalized DKG result used by the wallet */
export interface FullDkgResult {
  groupPublicKeyHex: string;
  keyPackages: Record<number, string>;   // participant → JSON string
  publicKeyPackage: string;              // JSON string
}

/** State of a single participant during round-by-round DKG */
export interface ParticipantDkgState {
  id: number;
  round1Secret?: number[];
  round1Package?: number[];
  round2Secret?: number[];
  round2Packages?: Record<number, number[]>;
  keyPackage?: number[];
  publicKeyPackage?: number[];
}
