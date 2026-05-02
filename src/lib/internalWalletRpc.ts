import { Buffer } from "buffer";
import {
  VAULKYRIE_INTERNAL_RPC,
  type CreatePrivacyVaultAccountParams,
  type CreatePrivacyVaultAccountResult,
  type CreateQuantumVaultKeyParams,
  type CreateQuantumVaultKeyResult,
  type InternalRpcMethod,
  type InternalRpcRequest,
  type InternalRpcResponse,
  type InternalSignMessageParams,
  type InternalSignMessageResult,
  type InternalSignTransactionParams,
  type InternalSignTransactionResult,
  type MigrateSensitiveRecordsResult,
  type PrepareQuantumVaultAdvanceParams,
  type PrepareQuantumVaultAdvanceResult,
  type RevealPrivacyVaultRecoveryParams,
  type RevealPrivacyVaultRecoveryResult,
  type RevealQuantumVaultRecoveryParams,
  type RevealQuantumVaultRecoveryResult,
  type UmbraOperationParams,
  type WalletSessionStatusResult,
} from "@/extension/messages";

function hasRuntimeMessaging(): boolean {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") {
    return false;
  }

  if (typeof window === "undefined") {
    return true;
  }

  return window.location.protocol === "chrome-extension:" || window.location.protocol === "moz-extension:";
}

async function callDirectInternalWalletRpc<TResult>(
  method: InternalRpcMethod,
  params?: Record<string, unknown>,
): Promise<TResult> {
  switch (method) {
    case "getWalletSessionStatus": {
      const { isWalletSessionUnlocked } = await import("@/background/sessionState");
      return { unlocked: isWalletSessionUnlocked() } as TResult;
    }
    case "setWalletSession": {
      const { setWalletSessionPasswordInBackground } = await import("@/background/sessionState");
      const payload = params as Partial<{ password: string }> | undefined;
      if (!payload?.password) {
        throw new Error("Missing wallet password.");
      }
      setWalletSessionPasswordInBackground(payload.password);
      return { unlocked: true } as TResult;
    }
    case "unlockWalletSession": {
      const { unlockWalletSessionInBackground } = await import("@/background/sessionState");
      const payload = params as Partial<{ password: string }> | undefined;
      if (!payload?.password) {
        throw new Error("Missing wallet password.");
      }
      await unlockWalletSessionInBackground(payload.password);
      return { unlocked: true } as TResult;
    }
    case "lockWalletSession": {
      const { lockWalletSessionInBackground } = await import("@/background/sessionState");
      lockWalletSessionInBackground();
      return { unlocked: false } as TResult;
    }
    case "createPrivacyVaultAccount": {
      const { createPrivacyVaultAccountInBackground } = await import("@/background/vaultSession");
      const payload = params as CreatePrivacyVaultAccountParams | undefined;
      if (!payload?.name?.trim()) {
        throw new Error("Privacy Vault name is required.");
      }
      return createPrivacyVaultAccountInBackground(payload.name.trim(), { mnemonic: payload.mnemonic }) as Promise<TResult>;
    }
    case "createQuantumVaultKey": {
      const { createQuantumVaultKeyInBackground } = await import("@/background/quantumVaultSession");
      const payload = params as CreateQuantumVaultKeyParams | undefined;
      if (!payload?.mode) {
        throw new Error("PQC key mode is required.");
      }
      return createQuantumVaultKeyInBackground(payload) as Promise<TResult>;
    }
    case "prepareQuantumVaultAdvance": {
      const { prepareQuantumVaultAdvanceInBackground } = await import("@/background/quantumVaultSession");
      const payload = params as PrepareQuantumVaultAdvanceParams | undefined;
      if (
        !payload?.walletPublicKey ||
        !payload.currentRootHex ||
        !payload.destinationAddress ||
        !payload.amountLamports ||
        !payload.sequence
      ) {
        throw new Error("PQC advance payload is incomplete.");
      }
      return prepareQuantumVaultAdvanceInBackground(payload) as Promise<TResult>;
    }
    case "signPrivacyVaultMessage": {
      const { signPrivacyVaultMessageInBackground } = await import("@/background/vaultSession");
      const payload = params as InternalSignMessageParams | undefined;
      if (!payload?.walletPublicKey || !payload.message) {
        throw new Error("Privacy Vault message payload is incomplete.");
      }
      const signature = await signPrivacyVaultMessageInBackground(
        payload.walletPublicKey,
        Uint8Array.from(Buffer.from(payload.message, "base64")),
      );
      return {
        signature: Buffer.from(signature).toString("base64"),
      } as TResult;
    }
    case "signPrivacyVaultTransaction": {
      const { signPrivacyVaultTransactionInBackground } = await import("@/background/vaultSession");
      const payload = params as InternalSignTransactionParams | undefined;
      if (
        !payload?.walletPublicKey ||
        !payload.serializedTransaction ||
        (payload.kind !== "legacy" && payload.kind !== "versioned")
      ) {
        throw new Error("Privacy Vault transaction payload is incomplete.");
      }
      return signPrivacyVaultTransactionInBackground(
        payload.walletPublicKey,
        payload.serializedTransaction,
        payload.kind,
      ) as Promise<TResult>;
    }
    case "revealPrivacyVaultRecovery": {
      const { revealPrivacyVaultRecoveryMaterialInBackground } = await import("@/background/vaultSession");
      const payload = params as RevealPrivacyVaultRecoveryParams | undefined;
      if (!payload?.walletPublicKey || !payload.password) {
        throw new Error("Privacy Vault recovery payload is incomplete.");
      }
      return revealPrivacyVaultRecoveryMaterialInBackground(payload.walletPublicKey, payload.password) as Promise<TResult>;
    }
    case "revealQuantumVaultRecovery": {
      const { revealQuantumVaultRecoveryMaterialInBackground } = await import("@/background/quantumVaultSession");
      const payload = params as RevealQuantumVaultRecoveryParams | undefined;
      if (!payload?.walletPublicKey || !payload.password) {
        throw new Error("PQC recovery payload is incomplete.");
      }
      return revealQuantumVaultRecoveryMaterialInBackground(payload.walletPublicKey, payload.password) as Promise<TResult>;
    }
    case "migrateSensitiveRecords": {
      const { migratePrivacyVaultRecordsInBackground } = await import("@/background/vaultSession");
      const { migrateQuantumVaultRecordsInBackground } = await import("@/background/quantumVaultSession");
      await migratePrivacyVaultRecordsInBackground();
      await migrateQuantumVaultRecordsInBackground();
      return { migrated: true } as TResult;
    }
    case "umbraOperation": {
      const payload = params as UmbraOperationParams | undefined;
      if (!payload?.walletPublicKey || !payload.network) {
        throw new Error("Umbra operation payload is incomplete.");
      }
      const { createDirectUmbraWalletClient } = await import("@/services/umbra/umbraClient");
      const client = await createDirectUmbraWalletClient(payload.walletPublicKey, payload.network);
      switch (payload.operation) {
        case "registerConfidential":
          return client.registerConfidential() as Promise<TResult>;
        case "queryAccountState":
          return client.queryAccountState(payload.params?.address) as Promise<TResult>;
        case "queryBalances":
          return client.queryBalances(payload.params?.tokens) as Promise<TResult>;
        case "deposit":
          if (!payload.params?.transfer) {
            throw new Error("Umbra deposit payload is incomplete.");
          }
          return client.deposit({
            destinationAddress: payload.params.transfer.destinationAddress,
            mint: payload.params.transfer.mint,
            amountAtomic: BigInt(payload.params.transfer.amountAtomic),
          }) as Promise<TResult>;
        case "withdraw":
          if (!payload.params?.transfer) {
            throw new Error("Umbra withdrawal payload is incomplete.");
          }
          return client.withdraw({
            destinationAddress: payload.params.transfer.destinationAddress,
            mint: payload.params.transfer.mint,
            amountAtomic: BigInt(payload.params.transfer.amountAtomic),
          }) as Promise<TResult>;
        case "privateSendFromEncryptedBalance":
          if (!payload.params?.privateTransfer) {
            throw new Error("Umbra private send payload is incomplete.");
          }
          return client.privateSendFromEncryptedBalance({
            destinationAddress: payload.params.privateTransfer.destinationAddress,
            mint: payload.params.privateTransfer.mint,
            amountAtomic: BigInt(payload.params.privateTransfer.amountAtomic),
          }) as Promise<TResult>;
        case "privateSendFromPublicBalance":
          if (!payload.params?.privateTransfer) {
            throw new Error("Umbra private send payload is incomplete.");
          }
          return client.privateSendFromPublicBalance({
            destinationAddress: payload.params.privateTransfer.destinationAddress,
            mint: payload.params.privateTransfer.mint,
            amountAtomic: BigInt(payload.params.privateTransfer.amountAtomic),
          }) as Promise<TResult>;
        case "scanIncomingUtxos":
          return client.scanIncomingUtxos(payload.params?.scanStartIndex) as Promise<TResult>;
        case "claimIncomingToEncryptedBalance":
          return client.claimIncomingToEncryptedBalance(payload.params?.utxos ?? []) as Promise<TResult>;
        default:
          throw new Error(`Unsupported Umbra operation: ${String(payload.operation)}`);
      }
    }
    default:
      throw new Error(`Unsupported internal wallet RPC method: ${method}`);
  }
}

async function callInternalWalletRpc<TResult>(
  method: InternalRpcMethod,
  params?: Record<string, unknown>,
): Promise<TResult> {
  if (!hasRuntimeMessaging()) {
    return callDirectInternalWalletRpc<TResult>(method, params);
  }
  const request: InternalRpcRequest = {
    type: VAULKYRIE_INTERNAL_RPC,
    id: crypto.randomUUID(),
    method,
    params,
  };

  return new Promise<TResult>((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(request, (response?: InternalRpcResponse<TResult>) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (!response) {
          reject(new Error("Vaulkyrie internal wallet RPC returned no response."));
          return;
        }
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response.result as TResult);
      });
    } catch {
      void callDirectInternalWalletRpc<TResult>(method, params).then(resolve, reject);
    }
  });
}

export async function getWalletSessionStatus(): Promise<WalletSessionStatusResult> {
  return callInternalWalletRpc<WalletSessionStatusResult>("getWalletSessionStatus");
}

export async function unlockWalletSession(password: string): Promise<void> {
  await callInternalWalletRpc<WalletSessionStatusResult>("unlockWalletSession", {
    password,
  });
}

export async function seedWalletSession(password: string): Promise<void> {
  await callInternalWalletRpc<WalletSessionStatusResult>("setWalletSession", {
    password,
  });
}

export async function lockWalletSession(): Promise<void> {
  await callInternalWalletRpc<WalletSessionStatusResult>("lockWalletSession");
}

export async function createPrivacyVaultAccountInBackground(
  params: CreatePrivacyVaultAccountParams,
): Promise<CreatePrivacyVaultAccountResult> {
  return callInternalWalletRpc<CreatePrivacyVaultAccountResult>("createPrivacyVaultAccount", params as unknown as Record<string, unknown>);
}

export async function createQuantumVaultKeyInBackground(
  params: CreateQuantumVaultKeyParams,
): Promise<CreateQuantumVaultKeyResult> {
  return callInternalWalletRpc<CreateQuantumVaultKeyResult>("createQuantumVaultKey", params as unknown as Record<string, unknown>);
}

export async function prepareQuantumVaultAdvanceInBackground(
  params: PrepareQuantumVaultAdvanceParams,
): Promise<PrepareQuantumVaultAdvanceResult> {
  return callInternalWalletRpc<PrepareQuantumVaultAdvanceResult>("prepareQuantumVaultAdvance", params as unknown as Record<string, unknown>);
}

export async function signPrivacyVaultMessageInBackground(
  params: InternalSignMessageParams,
): Promise<InternalSignMessageResult> {
  return callInternalWalletRpc<InternalSignMessageResult>("signPrivacyVaultMessage", params as unknown as Record<string, unknown>);
}

export async function signPrivacyVaultTransactionInBackground(
  params: InternalSignTransactionParams,
): Promise<InternalSignTransactionResult> {
  return callInternalWalletRpc<InternalSignTransactionResult>("signPrivacyVaultTransaction", params as unknown as Record<string, unknown>);
}

export async function revealPrivacyVaultRecoveryInBackground(
  params: RevealPrivacyVaultRecoveryParams,
): Promise<RevealPrivacyVaultRecoveryResult> {
  return callInternalWalletRpc<RevealPrivacyVaultRecoveryResult>("revealPrivacyVaultRecovery", params as unknown as Record<string, unknown>);
}

export async function revealQuantumVaultRecoveryInBackground(
  params: RevealQuantumVaultRecoveryParams,
): Promise<RevealQuantumVaultRecoveryResult> {
  return callInternalWalletRpc<RevealQuantumVaultRecoveryResult>("revealQuantumVaultRecovery", params as unknown as Record<string, unknown>);
}

export async function migrateSensitiveRecordsInBackground(): Promise<MigrateSensitiveRecordsResult> {
  return callInternalWalletRpc<MigrateSensitiveRecordsResult>("migrateSensitiveRecords");
}

export async function invokeUmbraOperationInBackground<TResult>(
  params: UmbraOperationParams,
): Promise<TResult> {
  return callInternalWalletRpc<TResult>("umbraOperation", params as unknown as Record<string, unknown>);
}
