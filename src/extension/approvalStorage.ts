export type ExtensionApprovalMethod = "connect" | "signTransaction" | "signMessage";
export type ExtensionApprovalStatus = "pending" | "approved" | "rejected" | "completed" | "failed";
export type ApprovedOriginUsageMethod =
  | "connect"
  | "getBalance"
  | "getTransactions"
  | "signTransaction"
  | "signMessage";
export type ApprovedSitePermission =
  | "connect"
  | "viewPublicKey"
  | "viewBalance"
  | "viewTransactions"
  | "requestTransactionSignatures"
  | "requestMessageSignatures";

export interface ApprovedOriginRequestCounts {
  connect: number;
  getBalance: number;
  getTransactions: number;
  signTransaction: number;
  signMessage: number;
}

export interface ApprovedOriginRecord {
  origin: string;
  accountPublicKey: string | null;
  approvedAt: number;
  lastUsedAt: number;
  lastUsedMethod: ApprovedOriginUsageMethod | null;
  grantedPermissions: ApprovedSitePermission[];
  requestCounts: ApprovedOriginRequestCounts;
}

export interface ExtensionApprovalDetailField {
  label: string;
  value: string;
  monospace?: boolean;
  tone?: "default" | "muted" | "warning";
}

export interface ExtensionApprovalDetails {
  title?: string;
  fields: ExtensionApprovalDetailField[];
  warnings?: string[];
}

export interface ExtensionApprovalRequest {
  id: string;
  origin: string;
  method: ExtensionApprovalMethod;
  createdAt: number;
  status: ExtensionApprovalStatus;
  expiresAt: number;
  accountPublicKey: string | null;
  summary: string;
  details?: ExtensionApprovalDetails;
  requestPayload?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  resolvedAt?: number;
  completedAt?: number;
}

const APPROVALS_KEY = "vaulkyrie-extension-approvals";
const APPROVED_ORIGINS_KEY = "vaulkyrie-extension-approved-origins";
const DEFAULT_GRANTED_PERMISSIONS: ApprovedSitePermission[] = [
  "connect",
  "viewPublicKey",
  "viewBalance",
  "viewTransactions",
  "requestTransactionSignatures",
  "requestMessageSignatures",
];
const EMPTY_REQUEST_COUNTS: ApprovedOriginRequestCounts = {
  connect: 0,
  getBalance: 0,
  getTransactions: 0,
  signTransaction: 0,
  signMessage: 0,
};

function isApprovedOriginUsageMethod(value: unknown): value is ApprovedOriginUsageMethod {
  return value === "connect"
    || value === "getBalance"
    || value === "getTransactions"
    || value === "signTransaction"
    || value === "signMessage";
}

function normalizeGrantedPermissions(value: unknown): ApprovedSitePermission[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_GRANTED_PERMISSIONS];
  }

  const permissions = value.filter((entry): entry is ApprovedSitePermission =>
    entry === "connect"
      || entry === "viewPublicKey"
      || entry === "viewBalance"
      || entry === "viewTransactions"
      || entry === "requestTransactionSignatures"
      || entry === "requestMessageSignatures",
  );

  return permissions.length > 0 ? permissions : [...DEFAULT_GRANTED_PERMISSIONS];
}

function normalizeRequestCounts(value: unknown): ApprovedOriginRequestCounts {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_REQUEST_COUNTS };
  }

  const candidate = value as Partial<ApprovedOriginRequestCounts>;
  return {
    connect: typeof candidate.connect === "number" ? candidate.connect : 0,
    getBalance: typeof candidate.getBalance === "number" ? candidate.getBalance : 0,
    getTransactions: typeof candidate.getTransactions === "number" ? candidate.getTransactions : 0,
    signTransaction: typeof candidate.signTransaction === "number" ? candidate.signTransaction : 0,
    signMessage: typeof candidate.signMessage === "number" ? candidate.signMessage : 0,
  };
}

function incrementRequestCount(
  counts: ApprovedOriginRequestCounts,
  method: ApprovedOriginUsageMethod,
): ApprovedOriginRequestCounts {
  return {
    ...counts,
    [method]: counts[method] + 1,
  };
}

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

function normalizeApprovedOriginRecords(
  value: unknown,
): ApprovedOriginRecord[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{
        origin: entry,
        accountPublicKey: null,
        approvedAt: 0,
        lastUsedAt: 0,
        lastUsedMethod: null,
        grantedPermissions: [...DEFAULT_GRANTED_PERMISSIONS],
        requestCounts: { ...EMPTY_REQUEST_COUNTS },
      }];
    }

    if (
      entry &&
      typeof entry === "object" &&
      "origin" in entry &&
      typeof entry.origin === "string"
    ) {
        return [{
          origin: entry.origin,
        accountPublicKey:
          "accountPublicKey" in entry && typeof entry.accountPublicKey === "string"
            ? entry.accountPublicKey
            : null,
        approvedAt:
          "approvedAt" in entry && typeof entry.approvedAt === "number"
            ? entry.approvedAt
            : 0,
          lastUsedAt:
            "lastUsedAt" in entry && typeof entry.lastUsedAt === "number"
              ? entry.lastUsedAt
              : 0,
          lastUsedMethod:
            "lastUsedMethod" in entry && isApprovedOriginUsageMethod(entry.lastUsedMethod)
              ? entry.lastUsedMethod
              : null,
          grantedPermissions:
            "grantedPermissions" in entry
              ? normalizeGrantedPermissions(entry.grantedPermissions)
              : [...DEFAULT_GRANTED_PERMISSIONS],
          requestCounts:
            "requestCounts" in entry
              ? normalizeRequestCounts(entry.requestCounts)
              : { ...EMPTY_REQUEST_COUNTS },
        }];
      }

    return [];
  });
}

async function readApprovedOriginRecords(): Promise<ApprovedOriginRecord[]> {
  const raw = await getStorageValue<unknown[]>(APPROVED_ORIGINS_KEY, []);
  return normalizeApprovedOriginRecords(raw);
}

function normalizeApprovalRequests(value: unknown): ExtensionApprovalRequest[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidate = entry as Partial<ExtensionApprovalRequest>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.origin !== "string" ||
      typeof candidate.method !== "string" ||
      typeof candidate.createdAt !== "number" ||
      typeof candidate.expiresAt !== "number" ||
      typeof candidate.status !== "string" ||
      typeof candidate.summary !== "string"
    ) {
      return [];
    }

    const details =
      candidate.details &&
      typeof candidate.details === "object" &&
      Array.isArray(candidate.details.fields)
        ? {
            title:
              typeof candidate.details.title === "string"
                ? candidate.details.title
                : undefined,
            fields: candidate.details.fields.flatMap((field) => {
              if (!field || typeof field !== "object") {
                return [];
              }

              const detail = field as Partial<ExtensionApprovalDetailField>;
              if (typeof detail.label !== "string" || typeof detail.value !== "string") {
                return [];
              }

              return [{
                label: detail.label,
                value: detail.value,
                monospace: detail.monospace === true,
                tone: (
                  detail.tone === "warning" || detail.tone === "muted"
                    ? detail.tone
                    : "default"
                ) as ExtensionApprovalDetailField["tone"],
              }];
            }),
            warnings: Array.isArray(candidate.details.warnings)
              ? candidate.details.warnings.filter((warning): warning is string => typeof warning === "string")
              : [],
          }
        : undefined;

    return [{
      id: candidate.id,
      origin: candidate.origin,
      method: candidate.method as ExtensionApprovalMethod,
      createdAt: candidate.createdAt,
      expiresAt: candidate.expiresAt,
      status: candidate.status as ExtensionApprovalStatus,
      accountPublicKey:
        typeof candidate.accountPublicKey === "string"
          ? candidate.accountPublicKey
          : null,
      summary: candidate.summary,
      details,
      requestPayload:
        candidate.requestPayload && typeof candidate.requestPayload === "object"
          ? candidate.requestPayload as Record<string, unknown>
          : undefined,
      result: candidate.result,
      error: typeof candidate.error === "string" ? candidate.error : undefined,
      resolvedAt: typeof candidate.resolvedAt === "number" ? candidate.resolvedAt : undefined,
      completedAt: typeof candidate.completedAt === "number" ? candidate.completedAt : undefined,
    }];
  });
}

export async function listExtensionApprovals(): Promise<ExtensionApprovalRequest[]> {
  const raw = await getStorageValue<unknown[]>(APPROVALS_KEY, []);
  return normalizeApprovalRequests(raw);
}

export async function listPendingExtensionApprovals(): Promise<ExtensionApprovalRequest[]> {
  const approvals = await listExtensionApprovals();
  return approvals
    .filter((approval) => approval.status === "pending" && approval.expiresAt > Date.now())
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
  status: "approved" | "rejected",
): Promise<void> {
  const approvals = await listExtensionApprovals();
  await setStorageValue(
    APPROVALS_KEY,
    approvals.map((approval) =>
      approval.id === id
        ? {
            ...approval,
            status,
            resolvedAt: Date.now(),
            error: status === "rejected" ? "Request rejected by user." : undefined,
          }
        : approval,
    ),
  );
}

export async function getExtensionApproval(id: string): Promise<ExtensionApprovalRequest | null> {
  const approvals = await listExtensionApprovals();
  return approvals.find((approval) => approval.id === id) ?? null;
}

export async function completeExtensionApproval(id: string, result: unknown): Promise<void> {
  const approvals = await listExtensionApprovals();
  await setStorageValue(
    APPROVALS_KEY,
    approvals.map((approval) =>
      approval.id === id
        ? {
            ...approval,
            status: "completed" as const,
            result,
            completedAt: Date.now(),
            error: undefined,
          }
        : approval,
    ),
  );
}

export async function failExtensionApproval(id: string, error: string): Promise<void> {
  const approvals = await listExtensionApprovals();
  await setStorageValue(
    APPROVALS_KEY,
    approvals.map((approval) =>
      approval.id === id
        ? {
            ...approval,
            status: "failed" as const,
            error,
            completedAt: Date.now(),
          }
        : approval,
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

export async function listApprovedOrigins(
  accountPublicKey?: string | null,
): Promise<ApprovedOriginRecord[]> {
  const approvedOrigins = await readApprovedOriginRecords();
  const filtered = accountPublicKey === undefined
    ? approvedOrigins
    : approvedOrigins.filter((record) => record.accountPublicKey === accountPublicKey);

  return filtered.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
}

export async function isOriginApproved(
  origin: string,
  accountPublicKey: string | null,
): Promise<boolean> {
  const approvedOrigins = await listApprovedOrigins(accountPublicKey);
  return approvedOrigins.some((record) => record.origin === origin);
}

export async function approveOrigin(
  origin: string,
  accountPublicKey: string | null,
): Promise<void> {
  const approvedOrigins = await readApprovedOriginRecords();
  const now = Date.now();
  const existingIndex = approvedOrigins.findIndex(
    (record) => record.origin === origin && record.accountPublicKey === accountPublicKey,
  );

  if (existingIndex >= 0) {
    approvedOrigins[existingIndex] = {
      ...approvedOrigins[existingIndex],
      approvedAt: approvedOrigins[existingIndex].approvedAt || now,
      lastUsedAt: now,
      lastUsedMethod: "connect",
      grantedPermissions:
        approvedOrigins[existingIndex].grantedPermissions.length > 0
          ? approvedOrigins[existingIndex].grantedPermissions
          : [...DEFAULT_GRANTED_PERMISSIONS],
      requestCounts: incrementRequestCount(
        approvedOrigins[existingIndex].requestCounts ?? { ...EMPTY_REQUEST_COUNTS },
        "connect",
      ),
    };
    await setStorageValue(APPROVED_ORIGINS_KEY, approvedOrigins);
    return;
  }

  await setStorageValue(APPROVED_ORIGINS_KEY, [
    {
      origin,
      accountPublicKey,
      approvedAt: now,
      lastUsedAt: now,
      lastUsedMethod: "connect",
      grantedPermissions: [...DEFAULT_GRANTED_PERMISSIONS],
      requestCounts: incrementRequestCount({ ...EMPTY_REQUEST_COUNTS }, "connect"),
    },
    ...approvedOrigins,
  ]);
}

export async function markOriginUsed(
  origin: string,
  accountPublicKey: string | null,
  method: ApprovedOriginUsageMethod = "connect",
): Promise<void> {
  const approvedOrigins = await readApprovedOriginRecords();
  const now = Date.now();
  const nextOrigins = approvedOrigins.map((record) =>
    record.origin === origin && record.accountPublicKey === accountPublicKey
      ? {
          ...record,
          lastUsedAt: now,
          lastUsedMethod: method,
          requestCounts: incrementRequestCount(record.requestCounts ?? { ...EMPTY_REQUEST_COUNTS }, method),
        }
      : record,
  );
  await setStorageValue(APPROVED_ORIGINS_KEY, nextOrigins);
}

export async function revokeOrigin(
  origin: string,
  accountPublicKey: string | null,
): Promise<void> {
  const approvedOrigins = await readApprovedOriginRecords();
  await setStorageValue(
    APPROVED_ORIGINS_KEY,
    approvedOrigins.filter(
      (record) => !(record.origin === origin && record.accountPublicKey === accountPublicKey),
    ),
  );
}

export async function revokeAllOrigins(
  accountPublicKey: string | null,
): Promise<void> {
  const approvedOrigins = await readApprovedOriginRecords();
  await setStorageValue(
    APPROVED_ORIGINS_KEY,
    approvedOrigins.filter((record) => record.accountPublicKey !== accountPublicKey),
  );
}

export async function listExtensionApprovalsForOrigin(
  origin: string,
  accountPublicKey?: string | null,
): Promise<ExtensionApprovalRequest[]> {
  const approvals = await listExtensionApprovals();
  return approvals
    .filter((approval) =>
      approval.origin === origin
        && (accountPublicKey === undefined || approval.accountPublicKey === accountPublicKey),
    )
    .sort((left, right) => right.createdAt - left.createdAt);
}
