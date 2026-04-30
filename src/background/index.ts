import {
  VAULKYRIE_EXTENSION_RPC,
  VAULKYRIE_INTERNAL_RPC,
  type ExtensionRpcRequest,
  type ExtensionRpcResponse,
  type InternalRpcRequest,
  type InternalRpcResponse,
  type ApprovalPendingResult,
  type ApprovalStatusParams,
  type ApprovalStatusResult,
  type CreatePrivacyVaultAccountParams,
  type InternalSignMessageParams,
  type InternalSignTransactionParams,
  type UmbraOperationParams,
} from "@/extension/messages";
import { readExtensionProviderState } from "@/extension/providerState";
import {
  isWalletSessionUnlocked,
  lockWalletSessionInBackground,
  setWalletSessionPasswordInBackground,
  unlockWalletSessionInBackground,
} from "@/background/sessionState";
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
  revokeOrigin,
  type ExtensionApprovalMethod,
  type ExtensionApprovalDetails,
  type ApprovedOriginUsageMethod,
} from "@/extension/approvalStorage";
import {
  buildMessageApprovalPreview,
  buildTransactionApprovalPreview,
} from "@/extension/approvalPreview";
import { formatUmbraErrorMessage } from "@/services/umbra/umbraError";

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
        const walletPublicKey = providerState.publicKey;
        const serializedTransaction = params.serializedTransaction;
        const transactionKind = params.kind;
        const signed = providerState.accountKind === "privacy-vault"
          ? await import("@/background/vaultSession").then(({ signPrivacyVaultTransactionInBackground }) =>
              signPrivacyVaultTransactionInBackground(
                walletPublicKey,
                serializedTransaction,
                transactionKind,
              ),
            )
          : await import("@/services/frost/signTransaction").then(({ signSerializedTransaction }) =>
              signSerializedTransaction(
                serializedTransaction,
                walletPublicKey,
                transactionKind,
              ),
            );
        result = {
          signedTransaction: "signedTransactionBase64" in signed ? signed.signedTransactionBase64 : signed.signedTransaction,
          kind: signed.kind,
        } satisfies SignTransactionResult;
        break;
      }
      case "signMessage": {
        const params = approval.requestPayload as Partial<SignMessageParams> | undefined;
        if (!providerState.publicKey || !params?.message) {
          throw new Error("Stored message approval payload is incomplete.");
        }
        const walletPublicKey = providerState.publicKey;
        const messageBytes = Buffer.from(params.message, "base64");
        const signature = providerState.accountKind === "privacy-vault"
          ? await import("@/background/vaultSession").then(({ signPrivacyVaultMessageInBackground }) =>
              signPrivacyVaultMessageInBackground(
                walletPublicKey,
                messageBytes,
              ),
            )
          : await import("@/services/frost/signTransaction").then(({ signMessageBytes }) =>
              signMessageBytes(
                walletPublicKey,
                messageBytes,
              ),
            );
        result = {
          signature: Buffer.from(signature).toString("base64"),
          publicKey: walletPublicKey,
        } satisfies SignMessageResult;
        break;
      }
      default:
        throw new Error(`Unsupported approval method: ${approval.method}`);
    }

    await completeExtensionApproval(approval.id, result);
    if (approval.method !== "connect") {
      await markOriginUsed(
        approval.origin,
        approval.accountPublicKey,
        approval.method as ApprovedOriginUsageMethod,
      );
    }
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
  method: ApprovedOriginUsageMethod = "connect",
): Promise<string> {
  ensurePageSender(sender);
  const origin = senderOrigin(sender);
  if (!(await isOriginApproved(origin, accountPublicKey))) {
    throw new Error("This site is not connected to the active vault. Connect it first.");
  }
  await markOriginUsed(origin, accountPublicKey, method);
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
        await markOriginUsed(senderOrigin(sender), providerState.publicKey, "connect");
      }
      return providerState;
    case "disconnect":
      if (providerState.publicKey) {
        await revokeOrigin(senderOrigin(sender), providerState.publicKey);
      }
      return { disconnected: true };
    case "getBalance": {
      if (!providerState.publicKey) {
        throw new Error("No active Vaulkyrie account found.");
      }
      await ensureApprovedOrigin(sender, providerState.publicKey, "getBalance");

      const [{ PublicKey }, { fetchSolBalance, withRpcFallback }] = await Promise.all([
        import("@solana/web3.js"),
        import("@/services/solanaRpc"),
      ]);
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
      await ensureApprovedOrigin(sender, providerState.publicKey, "getTransactions");

      const [{ PublicKey }, { fetchTransactionHistory, withRpcFallback }] = await Promise.all([
        import("@solana/web3.js"),
        import("@/services/solanaRpc"),
      ]);
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
        const { analyzeSerializedTransaction } = await import("@/services/transactionAnalysis");
        const analysis = await analyzeSerializedTransaction(providerState.network, params, providerState.publicKey);
        const preview = buildTransactionApprovalPreview(
          params,
          providerState.publicKey,
          analysis,
        );
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

async function handleInternalRequest(message: InternalRpcRequest) {
  switch (message.method) {
    case "getWalletSessionStatus":
      return { unlocked: isWalletSessionUnlocked() };
    case "setWalletSession": {
      const params = message.params as Partial<{ password: string }> | undefined;
      if (!params?.password) {
        throw new Error("Missing wallet password.");
      }
      setWalletSessionPasswordInBackground(params.password);
      return { unlocked: true };
    }
    case "unlockWalletSession": {
      const params = message.params as Partial<{ password: string }> | undefined;
      if (!params?.password) {
        throw new Error("Missing wallet password.");
      }
      await unlockWalletSessionInBackground(params.password);
      return { unlocked: true };
    }
    case "lockWalletSession":
      lockWalletSessionInBackground();
      return { unlocked: false };
    case "createPrivacyVaultAccount": {
      const params = message.params as CreatePrivacyVaultAccountParams | undefined;
      if (!params?.name?.trim()) {
        throw new Error("Privacy Vault name is required.");
      }
      return import("@/background/vaultSession").then(({ createPrivacyVaultAccountInBackground }) =>
        createPrivacyVaultAccountInBackground(params.name.trim()),
      );
    }
    case "signPrivacyVaultMessage": {
      const params = message.params as InternalSignMessageParams | undefined;
      if (!params?.walletPublicKey || !params.message) {
        throw new Error("Privacy Vault message payload is incomplete.");
      }
      const signature = await import("@/background/vaultSession").then(({ signPrivacyVaultMessageInBackground }) =>
        signPrivacyVaultMessageInBackground(
          params.walletPublicKey,
          Buffer.from(params.message, "base64"),
        ),
      );
      return {
        signature: Buffer.from(signature).toString("base64"),
      };
    }
    case "signPrivacyVaultTransaction": {
      const params = message.params as InternalSignTransactionParams | undefined;
      if (
        !params?.walletPublicKey ||
        !params.serializedTransaction ||
        (params.kind !== "legacy" && params.kind !== "versioned")
      ) {
        throw new Error("Privacy Vault transaction payload is incomplete.");
      }
      return import("@/background/vaultSession").then(({ signPrivacyVaultTransactionInBackground }) =>
        signPrivacyVaultTransactionInBackground(
          params.walletPublicKey,
          params.serializedTransaction,
          params.kind,
        ),
      );
    }
    case "umbraOperation": {
      const params = message.params as UmbraOperationParams | undefined;
      if (!params?.walletPublicKey || !params.network) {
        throw new Error("Umbra operation payload is incomplete.");
      }
      const client = await import("@/services/umbra/umbraClient").then(({ createDirectUmbraWalletClient }) =>
        createDirectUmbraWalletClient(params.walletPublicKey, params.network),
      );
      switch (params.operation) {
        case "registerConfidential":
          return client.registerConfidential();
        case "queryAccountState":
          return client.queryAccountState(params.params?.address);
        case "queryBalances":
          return client.queryBalances(params.params?.tokens);
        case "deposit":
          if (!params.params?.transfer) {
            throw new Error("Umbra deposit payload is incomplete.");
          }
          return client.deposit({
            destinationAddress: params.params.transfer.destinationAddress,
            mint: params.params.transfer.mint,
            amountAtomic: BigInt(params.params.transfer.amountAtomic),
          });
        case "withdraw":
          if (!params.params?.transfer) {
            throw new Error("Umbra withdrawal payload is incomplete.");
          }
          return client.withdraw({
            destinationAddress: params.params.transfer.destinationAddress,
            mint: params.params.transfer.mint,
            amountAtomic: BigInt(params.params.transfer.amountAtomic),
          });
        case "privateSendFromEncryptedBalance":
          if (!params.params?.privateTransfer) {
            throw new Error("Umbra private send payload is incomplete.");
          }
          return client.privateSendFromEncryptedBalance({
            destinationAddress: params.params.privateTransfer.destinationAddress,
            mint: params.params.privateTransfer.mint,
            amountAtomic: BigInt(params.params.privateTransfer.amountAtomic),
          });
        case "privateSendFromPublicBalance":
          if (!params.params?.privateTransfer) {
            throw new Error("Umbra private send payload is incomplete.");
          }
          return client.privateSendFromPublicBalance({
            destinationAddress: params.params.privateTransfer.destinationAddress,
            mint: params.params.privateTransfer.mint,
            amountAtomic: BigInt(params.params.privateTransfer.amountAtomic),
          });
        case "scanIncomingUtxos":
          return client.scanIncomingUtxos(params.params?.scanStartIndex);
        case "claimIncomingToEncryptedBalance":
          return client.claimIncomingToEncryptedBalance(params.params?.utxos ?? []);
        default:
          throw new Error(`Unsupported Umbra operation: ${String(params.operation)}`);
      }
    }
    default:
      throw new Error(`Unsupported internal wallet RPC method: ${message.method}`);
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionRpcRequest | InternalRpcRequest, sender, sendResponse) => {
  if (message?.type === VAULKYRIE_INTERNAL_RPC) {
    void handleInternalRequest(message as InternalRpcRequest)
      .then((result) => {
        const response: InternalRpcResponse = {
          id: message.id,
          result,
        };
        sendResponse(response);
      })
      .catch((error) => {
        const response: InternalRpcResponse = {
          id: message.id,
          error: formatUmbraErrorMessage(error),
        };
        sendResponse(response);
      });

    return true;
  }

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
        error: formatUmbraErrorMessage(error),
      };
      sendResponse(response);
    });

  return true;
});
