import type { NetworkId } from "@/lib/constants";

export type { NetworkId } from "@/lib/constants";

export interface WalletAccount {
  name: string;
  publicKey: string;
  balance: number;
  isActive: boolean;
}

export interface Token {
  symbol: string;
  name: string;
  mint?: string;
  balance: number;
  decimals?: number;
  usdPrice?: number;
  usdValue?: number;
  change24h?: number;
  icon?: string;
}

export interface Transaction {
  signature: string;
  type: "send" | "receive" | "swap" | "nft";
  amount: number;
  token?: string;
  from?: string;
  to?: string;
  timestamp: number;
  status: "confirmed" | "pending" | "failed";
  fee?: number;
}

export interface SpendOrchestrationPolicySnapshot {
  evaluationAddress: string;
  receiptCommitment: string;
  decisionCommitment: string;
  reasonCode: number;
  delayUntilSlot: string;
}

export interface SpendOrchestrationActivity {
  id: string;
  kind: "spend-orchestration";
  accountPublicKey: string;
  signature: string;
  amount: number;
  token: string;
  recipient: string;
  timestamp: number;
  network: NetworkId;
  actionHash: string;
  orchestrationAddress: string;
  policy?: SpendOrchestrationPolicySnapshot | null;
}

export interface RecoverySessionRecord {
  id: string;
  accountPublicKey: string;
  recoveryAccount: string;
  network: NetworkId;
  createdAt: number;
  updatedAt: number;
  status: "pending" | "complete" | "expired" | "unknown";
  expirySlot: string;
  newThreshold: number;
  newParticipantCount: number;
  recoveryCommitment: string;
  initSignature?: string | null;
  completeSignature?: string | null;
  newGroupKey?: string | null;
  newAuthorityHash?: string | null;
}

export interface Collectible {
  mint: string;
  name: string;
  symbol?: string;
  image?: string;
  collection?: string;
  description?: string;
}

export interface Contact {
  name: string;
  address: string;
  addedAt: number;
}

export interface VaultState {
  address: string;
  threshold: number;
  participants: number;
  policyConfigHash: string;
  authorityLeafIndex: number;
  pendingSessions: number;
}

export interface PolicyProfile {
  id: string;
  name: string;
  actionType: "send" | "admin";
  approvalMode: "allow" | "review" | "block";
  privacyMode?: "localPreview" | "arciumPrivate";
  template?:
    | "standardWallet"
    | "highSecurityWallet"
    | "treasuryOps"
    | "recoveryEscalation"
    | "adminQuarantine";
  tokenSymbol: string;
  maxAmount: number | null;
  allowedRecipients: string[];
  defaultProtocolRisk?: "none" | "low" | "medium" | "high" | "critical";
  defaultDeviceTrust?: "attested" | "trusted" | "degraded" | "unknown" | "compromised";
  guardianPosture?: "none" | "optional" | "available" | "verifiedQuorum";
  recipientMode?: "open" | "allowlist" | "sensitive";
  forcePqcReview?: boolean;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export interface PendingPolicyRequest {
  profileId: string;
  actionType: "send" | "admin";
  recipient: string;
  amount: number;
  tokenSymbol: string;
  createdAt: number;
}

export type PrivacyAssetSymbol = "SOL" | "USDC";
export type PrivacyProviderId = "nativeArcium" | "houdini" | "encifher" | "umbra";
export type PrivacyActionId = "deposit" | "transfer" | "withdraw" | "swapIntent" | "sealReceipt";

export interface PrivacyAccountRecord {
  id: string;
  ownerPublicKey: string;
  label: string;
  network: NetworkId;
  receiveCode: string;
  scanPublicKey: string;
  spendPublicKeyCommitment: string;
  viewingKeyCommitment: string;
  supportedAssets: PrivacyAssetSymbol[];
  createdAt: number;
  updatedAt: number;
}

export interface PrivacyReceiptRecord {
  id: string;
  accountId: string;
  ownerPublicKey: string;
  network: NetworkId;
  action: PrivacyActionId;
  asset: PrivacyAssetSymbol;
  amount: number;
  provider: PrivacyProviderId;
  recipientHint?: string | null;
  intentCommitment: string;
  signalCommitment: string;
  requestCommitment: string;
  receiptCommitment: string;
  packedSignalLanes: [string, string];
  privacyScore: number;
  minConfirmations: number;
  decisionFlags: number;
  status: "draft" | "queued" | "sealed" | "settled" | "failed";
  disclosureMode: "none" | "userReceipt" | "selectiveAudit" | "businessAudit";
  createdAt: number;
}

export type WalletView =
  | "dashboard"
  | "send"
  | "receive"
  | "swap"
  | "activity"
  | "settings"
  | "recovery"
  | "vault"
  | "quantum-vault"
  | "onboarding"
  | "vault-config"
  | "import-vault"
  | "dkg-ceremony"
  | "join-ceremony"
  | "contacts"
  | "lock"
  | "policy"
  | "privacy"
  | "approval";
