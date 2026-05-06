/** Vaulkyrie on-chain error codes. Maps numeric code → human-readable name + message. */
export const VAULKYRIE_ERRORS: Record<
  number,
  { name: string; message: string }
> = {
  // ── Expiry ──
  6000: { name: "ReceiptExpired", message: "Receipt has expired" },
  6001: { name: "SessionExpired", message: "Session has expired" },
  6002: {
    name: "AuthorityStatementExpired",
    message: "Authority rotation statement has expired",
  },
  6003: {
    name: "OrchestrationExpired",
    message: "Spend orchestration has expired",
  },
  6004: { name: "RecoveryExpired", message: "Recovery has expired" },

  // ── Replay ──
  6010: { name: "ReceiptNonceReplay", message: "Receipt nonce already consumed" },
  6011: {
    name: "AuthorityStatementReplay",
    message: "Authority statement already consumed",
  },

  // ── Mismatch ──
  6020: {
    name: "VaultAuthorityMismatch",
    message: "Vault authority hash does not match",
  },
  6021: {
    name: "VaultPolicyMismatch",
    message: "Vault policy version does not match receipt",
  },
  6022: {
    name: "SessionPolicyMismatch",
    message: "Session policy version does not match",
  },
  6023: { name: "SessionMismatch", message: "Session state does not match" },
  6024: {
    name: "AuthorityActionMismatch",
    message: "Authority action hash mismatch",
  },
  6025: {
    name: "OrchestrationActionMismatch",
    message: "Orchestration action hash mismatch",
  },
  6026: {
    name: "AuthoritySequenceMismatch",
    message: "Authority sequence not monotonically advancing",
  },
  6027: {
    name: "AuthorityLeafIndexMismatch",
    message: "Authority XMSS leaf index mismatch",
  },
  6028: {
    name: "AuthorityProofMismatch",
    message: "Authority proof does not match expected",
  },
  6029: {
    name: "AuthorityMerkleRootMismatch",
    message: "Authority merkle root does not match",
  },

  // ── State transitions ──
  6030: {
    name: "VaultStatusBadTransition",
    message: "Invalid vault status transition",
  },

  // ── Requirements ──
  6040: {
    name: "SessionRequiresPqc",
    message: "Session action requires PQC authorization",
  },
  6041: { name: "AuthorityNoOp", message: "Authority rotation is a no-op" },
  6042: {
    name: "AuthorityTreeExhausted",
    message: "XMSS authority tree is exhausted",
  },
  6043: {
    name: "AuthorityMigrationNoOp",
    message: "Authority migration is a no-op (same root)",
  },
  6044: {
    name: "PolicyVersionNotMonotonic",
    message: "Policy version is not monotonically increasing",
  },

  // ── Proof validation ──
  6050: {
    name: "AuthorityProofInvalid",
    message: "WOTS+ authority proof is invalid",
  },
  6051: {
    name: "BridgedReceiptDelayNotMet",
    message: "Bridged receipt confirmation delay not met",
  },

  // ── Structural ──
  6100: {
    name: "DuplicateAccountKeys",
    message: "Duplicate account keys in instruction",
  },
  6101: {
    name: "ProofChunkOffsetMismatch",
    message: "Proof chunk offset does not match bytes written",
  },
  6102: {
    name: "ProofChunkOverflow",
    message: "Proof chunk would overflow proof buffer",
  },
  6103: {
    name: "ProofChunkTooLarge",
    message: "Proof chunk exceeds maximum size",
  },
  6104: {
    name: "ProofStatementMismatch",
    message: "Proof statement digest does not match",
  },
  6105: {
    name: "ProofCommitmentMismatch",
    message: "Proof commitment does not match",
  },
  6106: {
    name: "AuthorityHashMismatch",
    message: "Authority hash does not match vault state",
  },
  6107: {
    name: "PolicyVersionMismatch",
    message: "Policy version does not match vault state",
  },
};

/**
 * Decode a Vaulkyrie program error from a transaction error.
 * Custom program errors appear as `InstructionError[N, Custom(code)]`.
 */
export function decodeVaulkyrieError(
  code: number
): { name: string; message: string } | null {
  return VAULKYRIE_ERRORS[code] ?? null;
}

/**
 * Try to extract and decode a Vaulkyrie error from a SendTransactionError.
 */
export function parseTransactionError(
  error: unknown
): { code: number; name: string; message: string } | null {
  if (!error || typeof error !== "object") return null;

  const err = error as Record<string, unknown>;
  const logs = (err.logs ?? err.message ?? "") as string;
  const match =
    typeof logs === "string"
      ? logs.match(/custom program error: 0x([0-9a-fA-F]+)/)
      : null;

  if (match) {
    const code = parseInt(match[1], 16);
    const decoded = decodeVaulkyrieError(code);
    if (decoded) return { code, ...decoded };
  }

  return null;
}
