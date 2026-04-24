import {
  VAULKYRIE_EXTENSION_RPC,
  VAULKYRIE_PROVIDER_EVENT,
  VAULKYRIE_PROVIDER_REQUEST,
  VAULKYRIE_PROVIDER_RESPONSE,
  type ExtensionRpcRequest,
  type ExtensionRpcResponse,
  type ProviderEventMessage,
  type ProviderRequestMessage,
  type ProviderResponseMessage,
} from "@/extension/messages";
import { WALLET_STORAGE_KEY } from "@/lib/walletPersistStorage";

// Vaulkyrie content script — injects the Solana wallet provider into dApp pages

const injectProvider = () => {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/injected/index.ts");
  script.type = "module";
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectProvider, { once: true });
} else {
  injectProvider();
}

function postResponse(message: ProviderResponseMessage | ProviderEventMessage) {
  window.postMessage(message, "*");
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== VAULKYRIE_PROVIDER_REQUEST) {
    return;
  }

  const message = event.data as ProviderRequestMessage;
  const request: ExtensionRpcRequest = {
    type: VAULKYRIE_EXTENSION_RPC,
    id: message.id,
    method: message.method,
    params: message.params,
  };

  chrome.runtime.sendMessage(request, (response?: ExtensionRpcResponse) => {
    const runtimeError = chrome.runtime.lastError;
    if (runtimeError) {
      postResponse({
        type: VAULKYRIE_PROVIDER_RESPONSE,
        id: message.id,
        error: runtimeError.message,
      });
      return;
    }

    postResponse({
      type: VAULKYRIE_PROVIDER_RESPONSE,
      id: message.id,
      result: response?.result,
      error: response?.error,
    });
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[WALLET_STORAGE_KEY]) {
    return;
  }

  const request: ExtensionRpcRequest = {
    type: VAULKYRIE_EXTENSION_RPC,
    id: crypto.randomUUID(),
    method: "getState",
  };

  chrome.runtime.sendMessage(request, (response?: ExtensionRpcResponse) => {
    if (chrome.runtime.lastError || response?.error || !response?.result) {
      return;
    }

    postResponse({
      type: VAULKYRIE_PROVIDER_EVENT,
      event: "stateChanged",
      state: response.result as ProviderEventMessage["state"],
    });
  });
});
