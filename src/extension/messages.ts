import type { ExtensionProviderState } from "./providerState";

export const VAULKYRIE_PROVIDER_REQUEST = "VAULKYRIE_PROVIDER_REQUEST";
export const VAULKYRIE_PROVIDER_RESPONSE = "VAULKYRIE_PROVIDER_RESPONSE";
export const VAULKYRIE_PROVIDER_EVENT = "VAULKYRIE_PROVIDER_EVENT";
export const VAULKYRIE_EXTENSION_RPC = "VAULKYRIE_EXTENSION_RPC";

export type ExtensionRpcMethod =
  | "getState"
  | "connect"
  | "disconnect"
  | "getBalance"
  | "getTransactions"
  | "signTransaction"
  | "signMessage"
  | "getApprovalStatus";

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
