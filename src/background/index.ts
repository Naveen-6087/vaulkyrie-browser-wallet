import { PublicKey } from "@solana/web3.js";
import {
  VAULKYRIE_EXTENSION_RPC,
  type ExtensionRpcRequest,
  type ExtensionRpcResponse,
  type ApprovalPendingResult,
  type ApprovalStatusParams,
  type ApprovalStatusResult,
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
  completeExtensionApproval,
  enqueueExtensionApproval,
  failExtensionApproval,
  getExtensionApproval,
  isOriginApproved,
  markOriginUsed,
  type ExtensionApprovalMethod,
  type ExtensionApprovalDetails,
} from "@/extension/approvalStorage";
import {
  buildMessageApprovalPreview,
  buildTransactionApprovalPreview,
} from "@/extension/approvalPreview";

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

function ensurePageSender(sender: chrome.runtime.MessageSender): void {
  if (!sender.tab?.id || !sender.tab.url) {
    throw new Error("Vaulkyrie rejected a request from an unknown page context.");
  }
}

function approvalSummary(method: ExtensionApprovalMethod, params?: Record<string, unknown>): {
  summary: string;
  details?: ExtensionApprovalDetails;
} {
  switch (method) {
    case "connect":
      return {
        summary: "Allow this site to connect to your active vault and read the public key and network.",
      };
    case "signTransaction":
      return {
        summary: `This site wants a ${String(params?.kind ?? "transaction")} transaction signed by your vault.`,
      };
    case "signMessage": {
      const encoded = typeof params?.message === "string" ? params.message : "";
      const bytes = Buffer.from(encoded, "base64");
      const preview = bytes.toString("utf8").replace(/\s+/g, " ").slice(0, 72);
      return {
        summary: preview
          ? `Message preview: "${preview}${preview.length >= 72 ? "…" : ""}"`
          : `This site wants a ${bytes.length}-byte message signed by your vault.`,
      };
    }
    default:
      return {
        summary: "This site is requesting access to your vault.",
      };
  }
}

const APPROVAL_TTL_MS = 5 * 60 * 1000;

async function beginApprovalRequest(
  sender: chrome.runtime.MessageSender,
  method: ExtensionApprovalMethod,
  accountPublicKey: string | null,
  preview?: {
    summary: string;
    details?: ExtensionApprovalDetails;
  },
  requestPayload?: Record<string, unknown>,
): Promise<ApprovalPendingResult> {
  const origin = senderOrigin(sender);
  const approval = preview ?? approvalSummary(method);
  const request = await enqueueExtensionApproval({
    id: crypto.randomUUID(),
    origin,
    method,
    createdAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_TTL_MS,
    accountPublicKey,
    summary: approval.summary,
    details: approval.details,
    requestPayload,
  });

  if (typeof chrome !== "undefined" && chrome.tabs?.create) {
    void chrome.tabs.create({
      url: chrome.runtime.getURL("index.html?view=approval"),
      active: true,
    });
  }

  return {
    approvalRequestId: request.id,
    status: "pending",
  };
}

async function executeApprovedRequest(
  approvalId: string,
  providerState: Awaited<ReturnType<typeof readExtensionProviderState>>,
  sender: chrome.runtime.MessageSender,
): Promise<ApprovalStatusResult> {
  const approval = await getExtensionApproval(approvalId);
  if (!approval) {
    throw new Error("Approval request was not found.");
  }

  if (approval.origin !== senderOrigin(sender)) {
    throw new Error("Approval request origin does not match the caller.");
  }

  if (approval.expiresAt <= Date.now() && approval.status === "pending") {
    await failExtensionApproval(approval.id, "Approval request expired before it was confirmed.");
    return {
      approvalRequestId: approval.id,
      status: "failed",
      error: "Approval request expired before it was confirmed.",
    };
  }

  if (approval.status === "pending") {
    return {
      approvalRequestId: approval.id,
      status: "pending",
    };
  }

  if (approval.status === "rejected") {
    return {
      approvalRequestId: approval.id,
      status: "rejected",
      error: approval.error ?? "Request rejected by user.",
    };
  }

  if (approval.status === "failed") {
    return {
      approvalRequestId: approval.id,
      status: "failed",
      error: approval.error ?? "Approval request failed.",
    };
  }

  if (approval.status === "completed") {
    return {
      approvalRequestId: approval.id,
      status: "completed",
      result: approval.result,
    };
  }

  if (approval.accountPublicKey && providerState.publicKey !== approval.accountPublicKey) {
    const error = "The active vault changed after this approval request was created.";
    await failExtensionApproval(approval.id, error);
    return {
      approvalRequestId: approval.id,
      status: "failed",
      error,
    };
  }

  try {
    let result: unknown;

    switch (approval.method) {
      case "connect":
        await approveOrigin(approval.origin, approval.accountPublicKey);
        result = providerState;
        break;
      case "signTransaction": {
        const params = approval.requestPayload as Partial<SignTransactionParams> | undefined;
        if (
          !providerState.publicKey ||
          !params?.serializedTransaction ||
          (params.kind !== "legacy" && params.kind !== "versioned")
        ) {
          throw new Error("Stored transaction approval payload is incomplete.");
        }
        const signed = await signSerializedTransaction(
          params.serializedTransaction,
          providerState.publicKey,
          params.kind,
        );
        result = {
          signedTransaction: signed.signedTransactionBase64,
          kind: signed.kind,
        } satisfies SignTransactionResult;
        break;
      }
      case "signMessage": {
        const params = approval.requestPayload as Partial<SignMessageParams> | undefined;
        if (!providerState.publicKey || !params?.message) {
          throw new Error("Stored message approval payload is incomplete.");
        }
        const signature = await signMessageBytes(
          providerState.publicKey,
          Buffer.from(params.message, "base64"),
        );
        result = {
          signature: Buffer.from(signature).toString("base64"),
          publicKey: providerState.publicKey,
        } satisfies SignMessageResult;
        break;
      }
      default:
        throw new Error(`Unsupported approval method: ${approval.method}`);
    }

    await completeExtensionApproval(approval.id, result);
    return {
      approvalRequestId: approval.id,
      status: "completed",
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failExtensionApproval(approval.id, message);
    return {
      approvalRequestId: approval.id,
      status: "failed",
      error: message,
    };
  }
}

async function ensureApprovedOrigin(
  sender: chrome.runtime.MessageSender,
  accountPublicKey: string | null,
): Promise<string> {
  ensurePageSender(sender);
  const origin = senderOrigin(sender);
  if (!(await isOriginApproved(origin, accountPublicKey))) {
    throw new Error("This site is not connected to the active vault. Connect it first.");
  }
  await markOriginUsed(origin, accountPublicKey);
  return origin;
}

async function handleRpcRequest(
  message: ExtensionRpcRequest,
  sender: chrome.runtime.MessageSender,
) {
  ensurePageSender(sender);
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
      if (!(await isOriginApproved(senderOrigin(sender), providerState.publicKey))) {
        return beginApprovalRequest(sender, "connect", providerState.publicKey);
      } else {
        await markOriginUsed(senderOrigin(sender), providerState.publicKey);
      }
      return providerState;
    case "disconnect":
      return { disconnected: true };
    case "getBalance": {
      if (!providerState.publicKey) {
        throw new Error("No active Vaulkyrie account found.");
      }
      await ensureApprovedOrigin(sender, providerState.publicKey);

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
      await ensureApprovedOrigin(sender, providerState.publicKey);

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
        const preview = buildTransactionApprovalPreview(params, providerState.publicKey);
        if (!preview.walletSignerRequired) {
          throw new Error("Vaulkyrie rejected this transaction because the active vault is not a required signer.");
        }
        return beginApprovalRequest(
          sender,
          "signTransaction",
          providerState.publicKey,
          preview,
          params as unknown as Record<string, unknown>,
        );
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
        return beginApprovalRequest(
          sender,
          "signMessage",
          providerState.publicKey,
          buildMessageApprovalPreview(params),
          params as unknown as Record<string, unknown>,
        );
      }
    case "getApprovalStatus": {
      const params = message.params as Partial<ApprovalStatusParams> | undefined;
      if (!params?.approvalRequestId) {
        throw new Error("Missing approval request identifier.");
      }
      return executeApprovedRequest(params.approvalRequestId, providerState, sender);
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
