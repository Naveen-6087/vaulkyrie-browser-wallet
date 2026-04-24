import { createJSONStorage, type StateStorage } from "zustand/middleware";

export const WALLET_STORAGE_KEY = "vaulkyrie-wallet-storage";

function canUseChromeStorage(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.storage?.local !== "undefined";
}

function getLocalStorageValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setLocalStorageValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore local fallback write failures.
  }
}

function removeLocalStorageValue(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore local fallback removal failures.
  }
}

async function chromeStorageGet(key: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      const value = result[key];
      resolve(typeof value === "string" ? value : null);
    });
  });
}

async function chromeStorageSet(key: string, value: string): Promise<void> {
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

async function chromeStorageRemove(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

const walletStateStorage: StateStorage<Promise<void> | void> = {
  async getItem(name) {
    if (canUseChromeStorage()) {
      const chromeValue = await chromeStorageGet(name);
      if (chromeValue) {
        return chromeValue;
      }

      const localValue = getLocalStorageValue(name);
      if (localValue) {
        await chromeStorageSet(name, localValue);
        return localValue;
      }

      return null;
    }

    return getLocalStorageValue(name);
  },
  async setItem(name, value) {
    if (canUseChromeStorage()) {
      await chromeStorageSet(name, value);
      setLocalStorageValue(name, value);
      return;
    }

    setLocalStorageValue(name, value);
  },
  async removeItem(name) {
    if (canUseChromeStorage()) {
      await chromeStorageRemove(name);
      removeLocalStorageValue(name);
      return;
    }

    removeLocalStorageValue(name);
  },
};

export const walletPersistStorage = createJSONStorage(() => walletStateStorage);

export interface PersistedWalletEnvelope<TState = Record<string, unknown>> {
  state?: TState;
  version?: number;
}

export async function readWalletPersistedEnvelope<TState = Record<string, unknown>>(
  key: string = WALLET_STORAGE_KEY,
): Promise<PersistedWalletEnvelope<TState> | null> {
  const raw = await walletStateStorage.getItem(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as PersistedWalletEnvelope<TState>;
  } catch {
    return null;
  }
}
