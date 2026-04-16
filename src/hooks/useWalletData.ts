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
    vaultState,
    error,
    lastFetchedAt,
    refreshAll,
    refreshBalances,
    refreshTransactions,
  } = useWalletStore();

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch on mount and when account/network changes
  useEffect(() => {
    if (!activeAccount) return;

    const now = Date.now();
    if (lastFetchedAt && now - lastFetchedAt < MIN_FETCH_INTERVAL_MS) return;

    refreshAll();
  }, [activeAccount?.publicKey, network]);

  // Poll every 30s for balance updates
  useEffect(() => {
    if (!activeAccount) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      refreshBalances();
    }, REFRESH_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [activeAccount?.publicKey]);

  return {
    tokens,
    transactions,
    vaultState,
    isLoading,
    error,
    lastFetchedAt,
    refreshAll,
    refreshBalances,
    refreshTransactions,
  };
}
