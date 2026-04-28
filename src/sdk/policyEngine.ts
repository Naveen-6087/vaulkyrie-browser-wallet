import type { PolicyProfile } from "@/types";
import { ThresholdRequirement } from "./constants";

export type PolicyTemplateId =
  | "standardWallet"
  | "highSecurityWallet"
  | "treasuryOps"
  | "recoveryEscalation"
  | "adminQuarantine";

export type PolicyScopeId = "spend" | "admin" | "recovery";
export type PolicyAmountBucketId = "dust" | "small" | "medium" | "large" | "whale";
export type PolicyBalanceBucketId = "low" | "medium" | "high" | "treasury";
export type PolicyLimitHeadroomBucketId =
  | "wide"
  | "comfortable"
  | "tight"
  | "nearLimit"
  | "exhausted";
export type PolicyVelocityBucketId = "idle" | "warm" | "elevated" | "burst";
export type PolicyRecipientClassId = "selfOwned" | "allowlisted" | "known" | "new" | "sensitive";
export type PolicyProtocolRiskBucketId = "none" | "low" | "medium" | "high" | "critical";
export type PolicyDeviceTrustBucketId =
  | "attested"
  | "trusted"
  | "degraded"
  | "unknown"
  | "compromised";
export type PolicyHistoryBucketId = "clean" | "warned" | "challenged" | "recoveryLinked";
export type PolicyGuardianPostureId = "none" | "optional" | "available" | "verifiedQuorum";

export interface WalletPolicySignals {
  template: PolicyTemplateId;
  scope: PolicyScopeId;
  amountBucket: PolicyAmountBucketId;
  balanceBucket: PolicyBalanceBucketId;
  limitHeadroomBucket: PolicyLimitHeadroomBucketId;
  velocityBucket: PolicyVelocityBucketId;
  recipientClass: PolicyRecipientClassId;
  protocolRisk: PolicyProtocolRiskBucketId;
  deviceTrust: PolicyDeviceTrustBucketId;
  historyBucket: PolicyHistoryBucketId;
  guardianPosture: PolicyGuardianPostureId;
  flags: number;
}

export interface WalletPolicyDecision {
  approved: boolean;
  threshold: number;
  delayUntilSlot: bigint;
  reasonCode: number;
  decisionFlags: number;
}

export interface WalletPolicySignalContext {
  policyProfile: PolicyProfile | null;
  actionType: "send" | "admin";
  recipient: string;
  amount: number;
  tokenSymbol: string;
  accountPublicKey?: string | null;
  tokenBalance?: number;
  totalBalance?: number;
  contacts?: ReadonlyArray<{ address: string }>;
  recentTransactions?: ReadonlyArray<{
    timestamp: number;
    status: "confirmed" | "pending" | "failed";
    type: string;
  }>;
  recoverySessions?: ReadonlyArray<{ status: string }>;
  cosignerEnabled?: boolean;
  cosignerAttested?: boolean;
  now?: Date;
}

interface PolicyBoilerplate {
  baseThreshold: number;
  elevatedThreshold: number;
  criticalThreshold: number;
  lowDelaySlots: bigint;
  mediumDelaySlots: bigint;
  highDelaySlots: bigint;
  severityBias: number;
  denyOnCompromisedSpend: boolean;
  requirePqcForAdmin: boolean;
}

export const POLICY_FLAG_NEW_DEVICE = 1 << 0;
export const POLICY_FLAG_OFF_HOURS = 1 << 1;
export const POLICY_FLAG_GEO_VELOCITY = 1 << 2;
export const POLICY_FLAG_ALLOWLIST_MATCH = 1 << 3;
export const POLICY_FLAG_PENDING_RECOVERY = 1 << 4;
export const POLICY_FLAG_AUDITOR_VISIBLE = 1 << 5;
export const POLICY_FLAG_TIMELOCK_BYPASS_REQUESTED = 1 << 6;
export const POLICY_FLAG_SERVER_COSIGNER_ATTESTED = 1 << 7;
export const POLICY_FLAG_GUARDIAN_ATTESTED = 1 << 8;
export const POLICY_FLAG_FORCE_PQC_REVIEW = 1 << 9;

export const DECISION_FLAG_LIMIT_ESCALATED = 1 << 0;
export const DECISION_FLAG_RECIPIENT_ESCALATED = 1 << 1;
export const DECISION_FLAG_PROTOCOL_ESCALATED = 1 << 2;
export const DECISION_FLAG_DEVICE_ESCALATED = 1 << 3;
export const DECISION_FLAG_HISTORY_ESCALATED = 1 << 4;
export const DECISION_FLAG_GUARDIAN_ESCALATED = 1 << 5;
export const DECISION_FLAG_DELAY_APPLIED = 1 << 6;
export const DECISION_FLAG_PQC_REQUIRED = 1 << 7;
export const DECISION_FLAG_DENIED = 1 << 8;
export const DECISION_FLAG_ADMIN_SCOPE = 1 << 9;
export const DECISION_FLAG_RECOVERY_SCOPE = 1 << 10;

const POLICY_REASON_CODE = {
  approved: 0,
  limitPressure: 10,
  recipientEscalation: 11,
  protocolRisk: 12,
  deviceTrust: 13,
  historyEscalation: 14,
  guardianEscalation: 15,
  recoveryEscalation: 30,
  adminPqcRequired: 40,
  deniedCriticalCompoundRisk: 90,
} as const;

const TEMPLATE_CODE: Record<PolicyTemplateId, number> = {
  standardWallet: 1,
  highSecurityWallet: 2,
  treasuryOps: 3,
  recoveryEscalation: 4,
  adminQuarantine: 5,
};

const SCOPE_CODE: Record<PolicyScopeId, number> = {
  spend: 1,
  admin: 2,
  recovery: 3,
};

const AMOUNT_BUCKET_CODE: Record<PolicyAmountBucketId, number> = {
  dust: 0,
  small: 1,
  medium: 2,
  large: 3,
  whale: 4,
};

const BALANCE_BUCKET_CODE: Record<PolicyBalanceBucketId, number> = {
  low: 0,
  medium: 1,
  high: 2,
  treasury: 3,
};

const LIMIT_BUCKET_CODE: Record<PolicyLimitHeadroomBucketId, number> = {
  wide: 0,
  comfortable: 1,
  tight: 2,
  nearLimit: 3,
  exhausted: 4,
};

const VELOCITY_BUCKET_CODE: Record<PolicyVelocityBucketId, number> = {
  idle: 0,
  warm: 1,
  elevated: 2,
  burst: 3,
};

const RECIPIENT_CLASS_CODE: Record<PolicyRecipientClassId, number> = {
  selfOwned: 0,
  allowlisted: 1,
  known: 2,
  new: 3,
  sensitive: 4,
};

const PROTOCOL_RISK_CODE: Record<PolicyProtocolRiskBucketId, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const DEVICE_TRUST_CODE: Record<PolicyDeviceTrustBucketId, number> = {
  attested: 0,
  trusted: 1,
  degraded: 2,
  unknown: 3,
  compromised: 4,
};

const HISTORY_BUCKET_CODE: Record<PolicyHistoryBucketId, number> = {
  clean: 0,
  warned: 1,
  challenged: 2,
  recoveryLinked: 3,
};

const GUARDIAN_POSTURE_CODE: Record<PolicyGuardianPostureId, number> = {
  none: 0,
  optional: 1,
  available: 2,
  verifiedQuorum: 3,
};

const TEMPLATE_BOILERPLATES: Record<PolicyTemplateId, PolicyBoilerplate> = {
  standardWallet: {
    baseThreshold: ThresholdRequirement.OneOfThree,
    elevatedThreshold: ThresholdRequirement.TwoOfThree,
    criticalThreshold: ThresholdRequirement.ThreeOfThree,
    lowDelaySlots: 0n,
    mediumDelaySlots: 30n,
    highDelaySlots: 120n,
    severityBias: 0,
    denyOnCompromisedSpend: true,
    requirePqcForAdmin: false,
  },
  highSecurityWallet: {
    baseThreshold: ThresholdRequirement.TwoOfThree,
    elevatedThreshold: ThresholdRequirement.ThreeOfThree,
    criticalThreshold: ThresholdRequirement.RequirePqcAuth,
    lowDelaySlots: 15n,
    mediumDelaySlots: 90n,
    highDelaySlots: 240n,
    severityBias: 2,
    denyOnCompromisedSpend: true,
    requirePqcForAdmin: true,
  },
  treasuryOps: {
    baseThreshold: ThresholdRequirement.TwoOfThree,
    elevatedThreshold: ThresholdRequirement.ThreeOfThree,
    criticalThreshold: ThresholdRequirement.RequirePqcAuth,
    lowDelaySlots: 30n,
    mediumDelaySlots: 120n,
    highDelaySlots: 480n,
    severityBias: 3,
    denyOnCompromisedSpend: true,
    requirePqcForAdmin: true,
  },
  recoveryEscalation: {
    baseThreshold: ThresholdRequirement.TwoOfThree,
    elevatedThreshold: ThresholdRequirement.ThreeOfThree,
    criticalThreshold: ThresholdRequirement.RequirePqcAuth,
    lowDelaySlots: 60n,
    mediumDelaySlots: 240n,
    highDelaySlots: 960n,
    severityBias: 4,
    denyOnCompromisedSpend: false,
    requirePqcForAdmin: true,
  },
  adminQuarantine: {
    baseThreshold: ThresholdRequirement.TwoOfThree,
    elevatedThreshold: ThresholdRequirement.RequirePqcAuth,
    criticalThreshold: ThresholdRequirement.RequirePqcAuth,
    lowDelaySlots: 120n,
    mediumDelaySlots: 600n,
    highDelaySlots: 1800n,
    severityBias: 5,
    denyOnCompromisedSpend: true,
    requirePqcForAdmin: true,
  },
};

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function sha256Parts(parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(payload));
  return new Uint8Array(digest);
}

function u16Le(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, true);
  return buf;
}

function u64Le(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

function u128Le(value: bigint): Uint8Array {
  const buf = new Uint8Array(16);
  let cursor = value;
  for (let index = 0; index < 16; index += 1) {
    buf[index] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  return buf;
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function normalizeProfile(profile: PolicyProfile | null): Required<
  Pick<
    PolicyProfile,
    | "approvalMode"
    | "actionType"
    | "template"
    | "defaultProtocolRisk"
    | "defaultDeviceTrust"
    | "guardianPosture"
    | "recipientMode"
    | "forcePqcReview"
  >
> &
  Pick<PolicyProfile, "maxAmount" | "allowedRecipients"> {
  const actionType = profile?.actionType ?? "send";
  return {
    approvalMode: profile?.approvalMode ?? "review",
    actionType,
    template: profile?.template ?? (actionType === "admin" ? "adminQuarantine" : "standardWallet"),
    defaultProtocolRisk:
      profile?.defaultProtocolRisk ?? (actionType === "admin" ? "medium" : "low"),
    defaultDeviceTrust: profile?.defaultDeviceTrust ?? "trusted",
    guardianPosture: profile?.guardianPosture ?? "optional",
    recipientMode: profile?.recipientMode ?? "open",
    forcePqcReview: profile?.forcePqcReview ?? false,
    maxAmount: profile?.maxAmount ?? null,
    allowedRecipients: profile?.allowedRecipients ?? [],
  };
}

function amountBucketFor(amount: number): PolicyAmountBucketId {
  if (amount < 0.1) return "dust";
  if (amount < 1) return "small";
  if (amount < 10) return "medium";
  if (amount < 100) return "large";
  return "whale";
}

function balanceBucketFor(balance: number): PolicyBalanceBucketId {
  if (balance < 1) return "low";
  if (balance < 25) return "medium";
  if (balance < 250) return "high";
  return "treasury";
}

function limitHeadroomBucketFor(amount: number, maxAmount: number | null): PolicyLimitHeadroomBucketId {
  if (maxAmount === null || maxAmount <= 0) return "wide";
  if (amount > maxAmount) return "exhausted";
  const usage = amount / maxAmount;
  if (usage >= 0.98) return "exhausted";
  if (usage >= 0.85) return "nearLimit";
  if (usage >= 0.6) return "tight";
  if (usage >= 0.3) return "comfortable";
  return "wide";
}

function velocityBucketFor(
  transactions: WalletPolicySignalContext["recentTransactions"],
  nowMs: number,
): PolicyVelocityBucketId {
  const windowStart = nowMs - 24 * 60 * 60 * 1000;
  const active = (transactions ?? []).filter((tx) => tx.timestamp >= windowStart && tx.type !== "receive");
  if (active.length >= 6) return "burst";
  if (active.length >= 3) return "elevated";
  if (active.length >= 1) return "warm";
  return "idle";
}

function recipientClassFor(
  recipient: string,
  accountPublicKey: string | null | undefined,
  contacts: WalletPolicySignalContext["contacts"],
  allowedRecipients: string[],
  recipientMode: NonNullable<PolicyProfile["recipientMode"]>,
  actionType: "send" | "admin",
): PolicyRecipientClassId {
  const normalizedRecipient = recipient.trim();
  const normalizedAllowed = new Set(allowedRecipients.map((item) => item.trim()).filter(Boolean));
  if (accountPublicKey && normalizedRecipient === accountPublicKey) return "selfOwned";
  if (normalizedAllowed.has(normalizedRecipient)) return "allowlisted";
  if (actionType === "admin" || recipientMode === "sensitive") return "sensitive";
  if ((contacts ?? []).some((contact) => contact.address === normalizedRecipient)) return "known";
  return "new";
}

function protocolRiskFor(
  actionType: "send" | "admin",
  configured: NonNullable<PolicyProfile["defaultProtocolRisk"]>,
): PolicyProtocolRiskBucketId {
  if (actionType === "admin" && (configured === "none" || configured === "low")) {
    return "medium";
  }
  return configured;
}

function historyBucketFor(
  recoverySessions: WalletPolicySignalContext["recoverySessions"],
  transactions: WalletPolicySignalContext["recentTransactions"],
  nowMs: number,
): PolicyHistoryBucketId {
  const hasRecoveryLink = (recoverySessions ?? []).some((session) =>
    session.status === "pending" || session.status === "unknown" || session.status === "complete",
  );
  if (hasRecoveryLink) return "recoveryLinked";
  const weekStart = nowMs - 7 * 24 * 60 * 60 * 1000;
  const failedTransactions = (transactions ?? []).filter(
    (tx) => tx.timestamp >= weekStart && tx.status === "failed",
  ).length;
  if (failedTransactions >= 3) return "challenged";
  if (failedTransactions >= 1) return "warned";
  return "clean";
}

function guardianPostureFor(
  configured: NonNullable<PolicyProfile["guardianPosture"]>,
  cosignerEnabled: boolean | undefined,
): PolicyGuardianPostureId {
  if (configured !== "optional") return configured;
  return cosignerEnabled ? "available" : configured;
}

function weightAmount(bucket: PolicyAmountBucketId): number {
  return { dust: 0, small: 1, medium: 2, large: 4, whale: 6 }[bucket];
}

function weightBalance(bucket: PolicyBalanceBucketId): number {
  return { low: 0, medium: 1, high: 2, treasury: 3 }[bucket];
}

function weightLimit(bucket: PolicyLimitHeadroomBucketId): number {
  return { wide: 0, comfortable: 1, tight: 3, nearLimit: 5, exhausted: 7 }[bucket];
}

function weightVelocity(bucket: PolicyVelocityBucketId): number {
  return { idle: 0, warm: 1, elevated: 3, burst: 5 }[bucket];
}

function weightRecipient(bucket: PolicyRecipientClassId): number {
  return { selfOwned: 0, allowlisted: 0, known: 1, new: 3, sensitive: 5 }[bucket];
}

function weightProtocol(bucket: PolicyProtocolRiskBucketId): number {
  return { none: 0, low: 1, medium: 2, high: 4, critical: 7 }[bucket];
}

function weightDevice(bucket: PolicyDeviceTrustBucketId): number {
  return { attested: 0, trusted: 1, degraded: 4, unknown: 6, compromised: 10 }[bucket];
}

function weightHistory(bucket: PolicyHistoryBucketId): number {
  return { clean: 0, warned: 2, challenged: 4, recoveryLinked: 6 }[bucket];
}

function weightGuardian(bucket: PolicyGuardianPostureId): number {
  return { none: 0, optional: 1, available: 2, verifiedQuorum: 0 }[bucket];
}

function severityScore(signals: WalletPolicySignals): number {
  return (
    weightAmount(signals.amountBucket) +
    weightBalance(signals.balanceBucket) +
    weightLimit(signals.limitHeadroomBucket) +
    weightVelocity(signals.velocityBucket) +
    weightRecipient(signals.recipientClass) +
    weightProtocol(signals.protocolRisk) +
    weightDevice(signals.deviceTrust) +
    weightHistory(signals.historyBucket) +
    weightGuardian(signals.guardianPosture)
  );
}

export function deriveWalletPolicySignals(context: WalletPolicySignalContext): WalletPolicySignals {
  const profile = normalizeProfile(context.policyProfile);
  const now = context.now ?? new Date();
  const nowMs = now.getTime();
  const scope: PolicyScopeId =
    profile.actionType === "admin"
      ? profile.template === "recoveryEscalation"
        ? "recovery"
        : "admin"
      : "spend";
  const recipientClass = recipientClassFor(
    context.recipient,
    context.accountPublicKey,
    context.contacts,
    profile.allowedRecipients,
    profile.recipientMode,
    context.actionType,
  );
  const deviceTrust = profile.defaultDeviceTrust;
  const historyBucket = historyBucketFor(context.recoverySessions, context.recentTransactions, nowMs);
  const guardianPosture = guardianPostureFor(profile.guardianPosture, context.cosignerEnabled);
  const protocolRisk = protocolRiskFor(context.actionType, profile.defaultProtocolRisk);
  const velocityBucket = velocityBucketFor(context.recentTransactions, nowMs);
  const amount = Number.isFinite(context.amount) ? Math.max(context.amount, 0) : 0;
  const tokenBalance = Number.isFinite(context.tokenBalance ?? NaN)
    ? Math.max(context.tokenBalance ?? 0, 0)
    : Math.max(context.totalBalance ?? 0, 0);
  const totalBalance = Number.isFinite(context.totalBalance ?? NaN)
    ? Math.max(context.totalBalance ?? 0, 0)
    : tokenBalance;

  let flags = 0;
  if (deviceTrust === "unknown" || deviceTrust === "degraded") {
    flags |= POLICY_FLAG_NEW_DEVICE;
  }
  const hour = now.getHours();
  if (hour < 6 || hour >= 22) {
    flags |= POLICY_FLAG_OFF_HOURS;
  }
  if ((velocityBucket === "elevated" || velocityBucket === "burst") && (recipientClass === "new" || recipientClass === "sensitive")) {
    flags |= POLICY_FLAG_GEO_VELOCITY;
  }
  if (recipientClass === "allowlisted") {
    flags |= POLICY_FLAG_ALLOWLIST_MATCH;
  }
  if (historyBucket === "recoveryLinked") {
    flags |= POLICY_FLAG_PENDING_RECOVERY;
  }
  if (profile.forcePqcReview) {
    flags |= POLICY_FLAG_FORCE_PQC_REVIEW;
  }
  if (context.cosignerAttested) {
    flags |= POLICY_FLAG_SERVER_COSIGNER_ATTESTED;
  }
  if (guardianPosture === "available" || guardianPosture === "verifiedQuorum") {
    flags |= POLICY_FLAG_GUARDIAN_ATTESTED;
  }

  return {
    template: profile.template,
    scope,
    amountBucket: amountBucketFor(amount),
    balanceBucket: balanceBucketFor(Math.max(tokenBalance, totalBalance)),
    limitHeadroomBucket: limitHeadroomBucketFor(amount, profile.maxAmount),
    velocityBucket,
    recipientClass,
    protocolRisk,
    deviceTrust,
    historyBucket,
    guardianPosture,
    flags,
  };
}

export function packWalletPolicySignalLanes(signals: WalletPolicySignals): [bigint, bigint] {
  const lane0 =
    BigInt(TEMPLATE_CODE[signals.template]) |
    (BigInt(SCOPE_CODE[signals.scope]) << 8n) |
    (BigInt(AMOUNT_BUCKET_CODE[signals.amountBucket]) << 16n) |
    (BigInt(BALANCE_BUCKET_CODE[signals.balanceBucket]) << 24n) |
    (BigInt(LIMIT_BUCKET_CODE[signals.limitHeadroomBucket]) << 32n) |
    (BigInt(VELOCITY_BUCKET_CODE[signals.velocityBucket]) << 40n) |
    (BigInt(RECIPIENT_CLASS_CODE[signals.recipientClass]) << 48n) |
    (BigInt(PROTOCOL_RISK_CODE[signals.protocolRisk]) << 56n) |
    (BigInt(DEVICE_TRUST_CODE[signals.deviceTrust]) << 64n) |
    (BigInt(HISTORY_BUCKET_CODE[signals.historyBucket]) << 72n) |
    (BigInt(GUARDIAN_POSTURE_CODE[signals.guardianPosture]) << 80n);
  return [lane0, BigInt(signals.flags & 0xffff)];
}

export async function policySignalCommitment(signals: WalletPolicySignals): Promise<Uint8Array> {
  const [lane0, lane1] = packWalletPolicySignalLanes(signals);
  return sha256Parts([
    new TextEncoder().encode("VAULKYRIE_POLICY_SIGNALS_V1"),
    u128Le(lane0),
    u128Le(lane1),
  ]);
}

export function evaluateWalletPolicy(
  signals: WalletPolicySignals,
  currentSlot: bigint | number,
  expirySlot: bigint | number,
): WalletPolicyDecision {
  const boilerplate = TEMPLATE_BOILERPLATES[signals.template];
  let severity = severityScore(signals) + boilerplate.severityBias;
  let decisionFlags = 0;
  let reasonCode: number = POLICY_REASON_CODE.approved;
  let approved = true;

  if (signals.scope === "admin") {
    severity += 3;
    decisionFlags |= DECISION_FLAG_ADMIN_SCOPE;
  } else if (signals.scope === "recovery") {
    severity += 5;
    decisionFlags |= DECISION_FLAG_RECOVERY_SCOPE;
    reasonCode = POLICY_REASON_CODE.recoveryEscalation;
  }

  if (weightLimit(signals.limitHeadroomBucket) >= 3) {
    decisionFlags |= DECISION_FLAG_LIMIT_ESCALATED;
    reasonCode = POLICY_REASON_CODE.limitPressure;
  }
  if (weightRecipient(signals.recipientClass) >= 3) {
    decisionFlags |= DECISION_FLAG_RECIPIENT_ESCALATED;
    reasonCode = POLICY_REASON_CODE.recipientEscalation;
  }
  if (weightProtocol(signals.protocolRisk) >= 4) {
    decisionFlags |= DECISION_FLAG_PROTOCOL_ESCALATED;
    reasonCode = POLICY_REASON_CODE.protocolRisk;
  }
  if (weightDevice(signals.deviceTrust) >= 4) {
    decisionFlags |= DECISION_FLAG_DEVICE_ESCALATED;
    reasonCode = POLICY_REASON_CODE.deviceTrust;
  }
  if (weightHistory(signals.historyBucket) >= 4) {
    decisionFlags |= DECISION_FLAG_HISTORY_ESCALATED;
    reasonCode = POLICY_REASON_CODE.historyEscalation;
  }
  if (weightGuardian(signals.guardianPosture) >= 2) {
    decisionFlags |= DECISION_FLAG_GUARDIAN_ESCALATED;
    reasonCode = POLICY_REASON_CODE.guardianEscalation;
  }

  if ((signals.flags & POLICY_FLAG_PENDING_RECOVERY) !== 0) {
    severity += 4;
    decisionFlags |= DECISION_FLAG_RECOVERY_SCOPE;
    reasonCode = POLICY_REASON_CODE.recoveryEscalation;
  }
  if ((signals.flags & POLICY_FLAG_TIMELOCK_BYPASS_REQUESTED) !== 0) {
    severity += 3;
  }
  if ((signals.flags & POLICY_FLAG_GEO_VELOCITY) !== 0) {
    severity += 2;
  }

  const criticalCompoundRisk =
    signals.scope === "spend" &&
    signals.protocolRisk === "critical" &&
    signals.recipientClass === "sensitive" &&
    (((signals.flags & POLICY_FLAG_OFF_HOURS) !== 0) ||
      ((signals.flags & POLICY_FLAG_TIMELOCK_BYPASS_REQUESTED) !== 0) ||
      signals.deviceTrust === "compromised");

  if (
    criticalCompoundRisk ||
    (signals.scope === "spend" &&
      signals.deviceTrust === "compromised" &&
      boilerplate.denyOnCompromisedSpend)
  ) {
    approved = false;
    decisionFlags |=
      DECISION_FLAG_DENIED |
      DECISION_FLAG_PROTOCOL_ESCALATED |
      DECISION_FLAG_RECIPIENT_ESCALATED |
      DECISION_FLAG_DEVICE_ESCALATED;
    reasonCode = POLICY_REASON_CODE.deniedCriticalCompoundRisk;
  }

  const requirePqc =
    (signals.flags & POLICY_FLAG_FORCE_PQC_REVIEW) !== 0 ||
    (signals.scope !== "spend" && boilerplate.requirePqcForAdmin) ||
    (signals.scope === "recovery" && signals.guardianPosture !== "verifiedQuorum");

  let threshold: number;
  if (!approved) {
    threshold =
      signals.scope === "spend" ? boilerplate.criticalThreshold : ThresholdRequirement.RequirePqcAuth;
  } else if (requirePqc) {
    decisionFlags |= DECISION_FLAG_PQC_REQUIRED;
    reasonCode = POLICY_REASON_CODE.adminPqcRequired;
    threshold = ThresholdRequirement.RequirePqcAuth;
  } else if (severity >= 18) {
    if (boilerplate.criticalThreshold === ThresholdRequirement.RequirePqcAuth) {
      decisionFlags |= DECISION_FLAG_PQC_REQUIRED;
      reasonCode = POLICY_REASON_CODE.adminPqcRequired;
    }
    threshold = boilerplate.criticalThreshold;
  } else if (severity >= 10) {
    threshold = boilerplate.elevatedThreshold;
  } else {
    threshold = boilerplate.baseThreshold;
  }

  const delaySlots =
    !approved
      ? boilerplate.highDelaySlots
      : threshold === ThresholdRequirement.RequirePqcAuth || severity >= 18
        ? boilerplate.highDelaySlots
        : severity >= 10
          ? boilerplate.mediumDelaySlots
          : boilerplate.lowDelaySlots;

  const currentSlotBig = toBigInt(currentSlot);
  const expirySlotBig = toBigInt(expirySlot);
  let delayUntilSlot = currentSlotBig + delaySlots;
  if (delayUntilSlot > expirySlotBig) {
    delayUntilSlot = expirySlotBig;
  }
  if (delayUntilSlot > currentSlotBig) {
    decisionFlags |= DECISION_FLAG_DELAY_APPLIED;
  }

  return {
    approved,
    threshold,
    delayUntilSlot,
    reasonCode,
    decisionFlags,
  };
}

export async function buildPolicyResultCommitment(params: {
  requestCommitment: Uint8Array;
  signalCommitment: Uint8Array;
  threshold: number;
  delayUntilSlot: bigint | number;
  reasonCode: number;
  decisionFlags: number;
  approved: boolean;
}): Promise<Uint8Array> {
  return sha256Parts([
    new TextEncoder().encode("VAULKYRIE_POLICY_RESULT_V1"),
    params.requestCommitment,
    params.signalCommitment,
    new Uint8Array([params.threshold & 0xff]),
    u64Le(toBigInt(params.delayUntilSlot)),
    u16Le(params.reasonCode),
    u16Le(params.decisionFlags),
    new Uint8Array([params.approved ? 1 : 0]),
  ]);
}
