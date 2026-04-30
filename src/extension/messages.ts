import type { ExtensionProviderState } from "./providerState";
import type {
  UmbraIncomingUtxos,
} from "@/services/umbra/umbraClient";
import type { UmbraTokenConfig } from "@/services/umbra/umbraConfig";
import type { NetworkId, WalletAccount } from "@/types";
import type { PrivacyVaultEncryptedKeyRecord } from "@/store/walletStore";

export const VAULKYRIE_PROVIDER_REQUEST = "VAULKYRIE_PROVIDER_REQUEST";
export const VAULKYRIE_PROVIDER_RESPONSE = "VAULKYRIE_PROVIDER_RESPONSE";
export const VAULKYRIE_PROVIDER_EVENT = "VAULKYRIE_PROVIDER_EVENT";
export const VAULKYRIE_EXTENSION_RPC = "VAULKYRIE_EXTENSION_RPC";
export const VAULKYRIE_INTERNAL_RPC = "VAULKYRIE_INTERNAL_RPC";

export type ExtensionRpcMethod =
  | "getState"
  | "connect"
  | "disconnect"
  | "getBalance"
  | "getTransactions"
  | "signTransaction"
  | "signMessage"
  | "getApprovalStatus";

export type InternalRpcMethod =
  | "getWalletSessionStatus"
  | "setWalletSession"
  | "unlockWalletSession"
  | "lockWalletSession"
  | "createPrivacyVaultAccount"
  | "signPrivacyVaultMessage"
  | "signPrivacyVaultTransaction"
  | "umbraOperation";

export interface SignTransactionParams {
  serializedTransaction: string;
  kind: "legacy" | "versioned";
}

export interface SignTransactionResult {
  signedTransaction: string;
  kind: "legacy" | "versioned";
}

export interface SignMessageParams {
  message: string;
}

export interface SignMessageResult {
  signature: string;
  publicKey: string;
}

export interface ApprovalPendingResult {
  approvalRequestId: string;
  status: "pending";
}

export interface ApprovalStatusParams {
  approvalRequestId: string;
}

export interface ApprovalStatusResult<T = unknown> {
  approvalRequestId: string;
  status: "pending" | "approved" | "rejected" | "completed" | "failed";
  result?: T;
  error?: string;
}

export interface ExtensionRpcRequest {
  type: typeof VAULKYRIE_EXTENSION_RPC;
  id: string;
  method: ExtensionRpcMethod;
  params?: Record<string, unknown>;
}

export interface ExtensionRpcResponse<T = unknown> {
  id: string;
  result?: T;
  error?: string;
}

export interface WalletSessionStatusResult {
  unlocked: boolean;
}

export interface UnlockWalletSessionParams {
  password: string;
}

export interface CreatePrivacyVaultAccountParams {
  name: string;
}

export interface CreatePrivacyVaultAccountResult {
  account: WalletAccount;
  keyRecord: PrivacyVaultEncryptedKeyRecord;
}

export interface InternalSignMessageParams {
  walletPublicKey: string;
  message: string;
}

export interface InternalSignMessageResult {
  signature: string;
}

export interface InternalSignTransactionParams {
  walletPublicKey: string;
  serializedTransaction: string;
  kind: "legacy" | "versioned";
}

export interface InternalSignTransactionResult {
  signedTransaction: string;
  kind: "legacy" | "versioned";
}

export type UmbraOperationName =
  | "registerConfidential"
  | "queryAccountState"
  | "queryBalances"
  | "deposit"
  | "withdraw"
  | "privateSendFromEncryptedBalance"
  | "privateSendFromPublicBalance"
  | "scanIncomingUtxos"
  | "claimIncomingToEncryptedBalance";

export interface UmbraOperationParams {
  walletPublicKey: string;
  network: NetworkId;
  operation: UmbraOperationName;
  params?: {
    address?: string;
    tokens?: UmbraTokenConfig[];
    scanStartIndex?: number;
    transfer?: { destinationAddress?: string; mint: string; amountAtomic: string };
    privateTransfer?: { destinationAddress: string; mint: string; amountAtomic: string };
    utxos?: UmbraIncomingUtxos["received"];
  };
}

export interface InternalRpcRequest {
  type: typeof VAULKYRIE_INTERNAL_RPC;
  id: string;
  method: InternalRpcMethod;
  params?: Record<string, unknown>;
}

export interface InternalRpcResponse<T = unknown> {
  id: string;
  result?: T;
  error?: string;
}

export interface ProviderRequestMessage {
  type: typeof VAULKYRIE_PROVIDER_REQUEST;
  id: string;
  method: ExtensionRpcMethod;
  params?: Record<string, unknown>;
}

export interface ProviderResponseMessage<T = unknown> {
  type: typeof VAULKYRIE_PROVIDER_RESPONSE;
  id: string;
  result?: T;
  error?: string;
}

export interface ProviderEventMessage {
  type: typeof VAULKYRIE_PROVIDER_EVENT;
  event: "stateChanged";
  state: ExtensionProviderState;
}
