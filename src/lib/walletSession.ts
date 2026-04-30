import {
  getWalletSessionStatus,
  lockWalletSession,
  seedWalletSession,
} from "@/lib/internalWalletRpc";

function hasRuntimeMessaging(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function";
}

export async function setWalletSessionPassword(password: string): Promise<void> {
  if (!hasRuntimeMessaging()) {
    const { setWalletSessionPasswordInBackground } = await import("@/background/sessionState");
    setWalletSessionPasswordInBackground(password);
    return;
  }
  await seedWalletSession(password);
}

export async function getWalletSessionPassword(): Promise<string | null> {
  return null;
}

export async function hasWalletSessionPassword(): Promise<boolean> {
  try {
    const status = await getWalletSessionStatus();
    return status.unlocked;
  } catch {
    return false;
  }
}

export async function clearWalletSessionPassword(): Promise<void> {
  if (!hasRuntimeMessaging()) {
    const { lockWalletSessionInBackground } = await import("@/background/sessionState");
    lockWalletSessionInBackground();
    return;
  }
  await lockWalletSession();
}
