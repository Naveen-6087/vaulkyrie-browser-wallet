import { useEffect, useRef } from "react";
import { useWalletStore } from "@/store/walletStore";

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds
const MIN_FETCH_INTERVAL_MS = 5_000; // debounce rapid calls

/**
 * Auto-refreshes wallet balances, transactions, and vault state
 * when the active account or network changes.
 * Polls every 30s while the wallet is unlocked.
 */
export function useWalletData() {
  const {
    activeAccount,
    network,
    isLoading,
    tokens,
    transactions,
    collectibles,
    vaultState,
    error,
    lastFetchedAt,
    refreshAll,
    refreshBalances,
    refreshTransactions,
    refreshCollectibles,
    refreshVaultState,
  } = useWalletStore();

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastRefreshContextRef = useRef<{ key: string; at: number } | null>(null);
  const activePublicKey = activeAccount?.publicKey;

  // Fetch on mount and when account/network changes
  useEffect(() => {
    if (!activePublicKey) {
      lastRefreshContextRef.current = null;
      return;
    }

    const key = `${network}:${activePublicKey}`;
    const now = Date.now();
    if (
      lastRefreshContextRef.current?.key === key &&
      now - lastRefreshContextRef.current.at < MIN_FETCH_INTERVAL_MS
    ) {
      return;
    }

    lastRefreshContextRef.current = { key, at: now };
    refreshAll();
  }, [activePublicKey, network, refreshAll]);

  // Poll every 30s for balance and activity updates.
  useEffect(() => {
    if (!activePublicKey) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      void Promise.all([
        refreshBalances(),
        refreshTransactions(),
        refreshVaultState(),
      ]);
    }, REFRESH_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [activePublicKey, network, refreshBalances, refreshTransactions, refreshVaultState]);

  return {
    tokens,
    transactions,
    collectibles,
    vaultState,
    isLoading,
    error,
    lastFetchedAt,
    refreshAll,
    refreshBalances,
    refreshTransactions,
    refreshCollectibles,
  };
}
