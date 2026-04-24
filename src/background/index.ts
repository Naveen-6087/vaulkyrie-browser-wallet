import { PublicKey } from "@solana/web3.js";
import {
  VAULKYRIE_EXTENSION_RPC,
  type ExtensionRpcRequest,
  type ExtensionRpcResponse,
} from "@/extension/messages";
import { readExtensionProviderState } from "@/extension/providerState";
import {
  fetchSolBalance,
  fetchTransactionHistory,
  withRpcFallback,
} from "@/services/solanaRpc";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Vaulkyrie] Extension installed");
});

async function handleRpcRequest(message: ExtensionRpcRequest) {
  const providerState = await readExtensionProviderState();

  switch (message.method) {
    case "getState":
      return providerState;
    case "connect":
      if (providerState.isLocked) {
        throw new Error("Vaulkyrie is locked. Unlock the wallet before connecting.");
      }
      if (!providerState.publicKey) {
        throw new Error("No active Vaulkyrie account found. Open the wallet and create or import one first.");
      }
      return providerState;
    case "disconnect":
      return { disconnected: true };
    case "getBalance": {
      if (!providerState.publicKey) {
        throw new Error("No active Vaulkyrie account found.");
      }

      const lamports = await withRpcFallback(providerState.network, (connection) =>
        fetchSolBalance(connection, new PublicKey(providerState.publicKey!)),
      );
      return {
        publicKey: providerState.publicKey,
        lamports,
      };
    }
    case "getTransactions": {
      if (!providerState.publicKey) {
        throw new Error("No active Vaulkyrie account found.");
      }

      const transactions = await withRpcFallback(providerState.network, (connection) =>
        fetchTransactionHistory(connection, new PublicKey(providerState.publicKey!), 20),
      );
      return {
        publicKey: providerState.publicKey,
        transactions,
      };
    }
    case "signTransaction":
      if (providerState.isLocked) {
        throw new Error("Vaulkyrie is locked. Unlock the wallet before signing.");
      }
      throw new Error("Extension transaction signing is not implemented yet.");
    default:
      throw new Error(`Unsupported extension RPC method: ${message.method}`);
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionRpcRequest, _sender, sendResponse) => {
  if (message?.type !== VAULKYRIE_EXTENSION_RPC) {
    return false;
  }

  void handleRpcRequest(message)
    .then((result) => {
      const response: ExtensionRpcResponse = {
        id: message.id,
        result,
      };
      sendResponse(response);
    })
    .catch((error) => {
      const response: ExtensionRpcResponse = {
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      };
      sendResponse(response);
    });

  return true;
});
