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
  | "signTransaction";

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
