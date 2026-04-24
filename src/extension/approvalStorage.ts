export type ExtensionApprovalMethod = "connect" | "signTransaction" | "signMessage";
export type ExtensionApprovalStatus = "pending" | "approved" | "rejected";

export interface ExtensionApprovalRequest {
  id: string;
  origin: string;
  method: ExtensionApprovalMethod;
  createdAt: number;
  status: ExtensionApprovalStatus;
  accountPublicKey: string | null;
  summary: string;
}

const APPROVALS_KEY = "vaulkyrie-extension-approvals";
const APPROVED_ORIGINS_KEY = "vaulkyrie-extension-approved-origins";

function canUseChromeStorage(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.storage?.local !== "undefined";
}

async function getStorageValue<T>(key: string, fallback: T): Promise<T> {
  if (canUseChromeStorage()) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve((result[key] as T | undefined) ?? fallback);
      });
    });
  }

  if (typeof localStorage === "undefined") {
    return fallback;
  }

  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function setStorageValue<T>(key: string, value: T): Promise<void> {
  if (canUseChromeStorage()) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: value }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  if (typeof localStorage === "undefined") {
    return;
  }

  localStorage.setItem(key, JSON.stringify(value));
}

export async function listExtensionApprovals(): Promise<ExtensionApprovalRequest[]> {
  return getStorageValue<ExtensionApprovalRequest[]>(APPROVALS_KEY, []);
}

export async function listPendingExtensionApprovals(): Promise<ExtensionApprovalRequest[]> {
  const approvals = await listExtensionApprovals();
  return approvals
    .filter((approval) => approval.status === "pending")
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function enqueueExtensionApproval(
  request: Omit<ExtensionApprovalRequest, "status">,
): Promise<ExtensionApprovalRequest> {
  const nextRequest: ExtensionApprovalRequest = {
    ...request,
    status: "pending",
  };
  const approvals = await listExtensionApprovals();
  await setStorageValue(APPROVALS_KEY, [nextRequest, ...approvals]);
  return nextRequest;
}

export async function resolveExtensionApproval(
  id: string,
  status: Exclude<ExtensionApprovalStatus, "pending">,
): Promise<void> {
  const approvals = await listExtensionApprovals();
  await setStorageValue(
    APPROVALS_KEY,
    approvals.map((approval) =>
      approval.id === id ? { ...approval, status } : approval,
    ),
  );
}

export async function removeExtensionApproval(id: string): Promise<void> {
  const approvals = await listExtensionApprovals();
  await setStorageValue(
    APPROVALS_KEY,
    approvals.filter((approval) => approval.id !== id),
  );
}

export async function waitForExtensionApproval(
  id: string,
  timeoutMs: number = 5 * 60 * 1000,
  intervalMs: number = 1000,
): Promise<Exclude<ExtensionApprovalStatus, "pending">> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const approvals = await listExtensionApprovals();
    const approval = approvals.find((item) => item.id === id);
    if (!approval) {
      throw new Error("Approval request disappeared before completion.");
    }
    if (approval.status !== "pending") {
      return approval.status;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Approval request timed out.");
}

export async function listApprovedOrigins(): Promise<string[]> {
  return getStorageValue<string[]>(APPROVED_ORIGINS_KEY, []);
}

export async function isOriginApproved(origin: string): Promise<boolean> {
  const approvedOrigins = await listApprovedOrigins();
  return approvedOrigins.includes(origin);
}

export async function approveOrigin(origin: string): Promise<void> {
  const approvedOrigins = await listApprovedOrigins();
  if (approvedOrigins.includes(origin)) return;
  await setStorageValue(APPROVED_ORIGINS_KEY, [...approvedOrigins, origin]);
}
