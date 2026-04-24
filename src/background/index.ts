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
import { signMessageBytes, signSerializedTransaction } from "@/services/frost/signTransaction";
import type {
  SignMessageParams,
  SignMessageResult,
  SignTransactionParams,
  SignTransactionResult,
} from "@/extension/messages";
import {
  approveOrigin,
  enqueueExtensionApproval,
  isOriginApproved,
  removeExtensionApproval,
  waitForExtensionApproval,
  type ExtensionApprovalMethod,
} from "@/extension/approvalStorage";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Vaulkyrie] Extension installed");
});

function senderOrigin(sender: chrome.runtime.MessageSender): string {
  if (sender.origin) return sender.origin;
  if (sender.url) {
    try {
      return new URL(sender.url).origin;
    } catch {
      return sender.url;
    }
  }
  if (sender.tab?.url) {
    try {
      return new URL(sender.tab.url).origin;
    } catch {
      return sender.tab.url;
    }
  }
  return "Unknown origin";
}

function approvalSummary(method: ExtensionApprovalMethod, params?: Record<string, unknown>): string {
  switch (method) {
    case "connect":
      return "Allow this site to connect to your active vault and read the public key and network.";
    case "signTransaction":
      return `This site wants a ${String(params?.kind ?? "transaction")} transaction signed by your vault.`;
    case "signMessage": {
      const encoded = typeof params?.message === "string" ? params.message : "";
      const bytes = Buffer.from(encoded, "base64");
      const preview = bytes.toString("utf8").replace(/\s+/g, " ").slice(0, 72);
      return preview
        ? `Message preview: "${preview}${preview.length >= 72 ? "…" : ""}"`
        : `This site wants a ${bytes.length}-byte message signed by your vault.`;
    }
    default:
      return "This site is requesting access to your vault.";
  }
}

async function requestApproval(
  sender: chrome.runtime.MessageSender,
  method: ExtensionApprovalMethod,
  accountPublicKey: string | null,
  params?: Record<string, unknown>,
): Promise<void> {
  const origin = senderOrigin(sender);
  const request = await enqueueExtensionApproval({
    id: crypto.randomUUID(),
    origin,
    method,
    createdAt: Date.now(),
    accountPublicKey,
    summary: approvalSummary(method, params),
  });

  if (typeof chrome !== "undefined" && chrome.tabs?.create) {
    void chrome.tabs.create({
      url: chrome.runtime.getURL("index.html?view=approval"),
      active: true,
    });
  }

  try {
    const decision = await waitForExtensionApproval(request.id);
    if (decision !== "approved") {
      throw new Error("Request rejected by user.");
    }
    if (method === "connect") {
      await approveOrigin(origin);
    }
  } finally {
    await removeExtensionApproval(request.id);
  }
}

async function handleRpcRequest(
  message: ExtensionRpcRequest,
  sender: chrome.runtime.MessageSender,
) {
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
      if (!(await isOriginApproved(senderOrigin(sender)))) {
        await requestApproval(sender, "connect", providerState.publicKey);
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
      if (!providerState.publicKey) {
        throw new Error("No active Vaulkyrie account found.");
      }
      if (!message.params) {
        throw new Error("Missing transaction payload.");
      }
      {
        const params = message.params as unknown as SignTransactionParams;
        if (!params.serializedTransaction || !params.kind) {
          throw new Error("Transaction payload is incomplete.");
        }
        await requestApproval(sender, "signTransaction", providerState.publicKey, {
          kind: params.kind,
        });
        const result = await signSerializedTransaction(
          params.serializedTransaction,
          providerState.publicKey,
          params.kind,
        );
        const response: SignTransactionResult = {
          signedTransaction: result.signedTransactionBase64,
          kind: result.kind,
        };
        return response;
      }
    case "signMessage":
      if (providerState.isLocked) {
        throw new Error("Vaulkyrie is locked. Unlock the wallet before signing.");
      }
      if (!providerState.publicKey) {
        throw new Error("No active Vaulkyrie account found.");
      }
      if (!message.params) {
        throw new Error("Missing message payload.");
      }
      {
        const params = message.params as unknown as SignMessageParams;
        if (!params.message) {
          throw new Error("Message payload is incomplete.");
        }
        await requestApproval(sender, "signMessage", providerState.publicKey, {
          message: params.message,
        });
        const signature = await signMessageBytes(
          providerState.publicKey,
          Buffer.from(params.message, "base64"),
        );
        const response: SignMessageResult = {
          signature: Buffer.from(signature).toString("base64"),
          publicKey: providerState.publicKey,
        };
        return response;
      }
    default:
      throw new Error(`Unsupported extension RPC method: ${message.method}`);
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionRpcRequest, sender, sendResponse) => {
  if (message?.type !== VAULKYRIE_EXTENSION_RPC) {
    return false;
  }

  void handleRpcRequest(message, sender)
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
