import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PublicKey } from "@solana/web3.js";
import type { WalletAccount, Token, Transaction, VaultState, WalletView } from "../types";
import { DEFAULT_NETWORK, type NetworkId } from "../lib/constants";
import {
  createConnection,
  createVaulkyrieClient,
  fetchTokenBalances,
  fetchTransactionHistory,
  fetchTokenPrices,
} from "../services/solanaRpc";

// Per-vault DKG key material stored in localStorage
interface StoredDkgResult {
  groupPublicKeyHex: string;
  publicKeyPackage: string;
  keyPackages: Record<number, string>;
  threshold: number;
  participants: number;
  createdAt: number;
}

interface VaultConfigPersist {
  vaultName: string;
  threshold: number;
  totalParticipants: number;
}

interface WalletState {
  // Auth
  isLocked: boolean;
  isOnboarded: boolean;
  hasHydrated: boolean;

  // Active account
  activeAccount: WalletAccount | null;
  accounts: WalletAccount[];

  // Per-vault DKG keys (keyed by publicKey)
  dkgResults: Record<string, StoredDkgResult>;

  // Vault configs (keyed by publicKey)
  vaultConfigs: Record<string, VaultConfigPersist>;

  // Tokens & transactions (real data from RPC)
  tokens: Token[];
  transactions: Transaction[];

  // Vault state (Vaulkyrie on-chain accounts)
  vaultState: VaultState | null;

  // Network
  network: NetworkId;

  // UI
  currentView: WalletView;

  // Loading / error
  isLoading: boolean;
  error: string | null;
  lastFetchedAt: number | null;

  // Sync actions
  setLocked: (locked: boolean) => void;
  setOnboarded: (onboarded: boolean) => void;
  setActiveAccount: (account: WalletAccount) => void;
  addAccount: (account: WalletAccount) => void;
  removeAccount: (publicKey: string) => void;
  switchVault: (publicKey: string) => void;
  setTokens: (tokens: Token[]) => void;
  setTransactions: (transactions: Transaction[]) => void;
  setVaultState: (state: VaultState | null) => void;
  setNetwork: (network: NetworkId) => void;
  setCurrentView: (view: WalletView) => void;
  clearError: () => void;

  // Hydration
  setHasHydrated: (hydrated: boolean) => void;

  // DKG key management
  storeDkgResult: (publicKey: string, result: StoredDkgResult) => void;
  getDkgResult: (publicKey: string) => StoredDkgResult | null;
  storeVaultConfig: (publicKey: string, config: VaultConfigPersist) => void;

  // Async actions — real Solana RPC calls
  refreshBalances: () => Promise<void>;
  refreshTransactions: () => Promise<void>;
  refreshVaultState: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      isLocked: true,
      isOnboarded: false,
      hasHydrated: false,
      activeAccount: null,
      accounts: [],
      dkgResults: {},
      vaultConfigs: {},
      tokens: [],
      transactions: [],
      vaultState: null,
      network: DEFAULT_NETWORK,
      currentView: "dashboard",
      isLoading: false,
      error: null,
      lastFetchedAt: null,

      setLocked: (locked) => set({ isLocked: locked }),
      setOnboarded: (onboarded) => set({ isOnboarded: onboarded }),
      setActiveAccount: (account) => set({ activeAccount: account }),
      addAccount: (account) =>
        set((state) => ({ accounts: [...state.accounts, account] })),
      removeAccount: (publicKey) =>
        set((state) => {
          const accounts = state.accounts.filter((a) => a.publicKey !== publicKey);
          const dkgResults = { ...state.dkgResults };
          delete dkgResults[publicKey];
          const vaultConfigs = { ...state.vaultConfigs };
          delete vaultConfigs[publicKey];
          const activeAccount =
            state.activeAccount?.publicKey === publicKey
              ? accounts[0] ?? null
              : state.activeAccount;
          return { accounts, dkgResults, vaultConfigs, activeAccount };
        }),
      switchVault: (publicKey) => {
        const { accounts } = get();
        const target = accounts.find((a) => a.publicKey === publicKey);
        if (target) {
          set({
            activeAccount: target,
            tokens: [],
            transactions: [],
            vaultState: null,
            lastFetchedAt: null,
          });
        }
      },
      setTokens: (tokens) => set({ tokens }),
      setTransactions: (transactions) => set({ transactions }),
      setVaultState: (vaultState) => set({ vaultState }),
      setNetwork: (network) => set({ network }),
      setCurrentView: (currentView) => set({ currentView }),
      clearError: () => set({ error: null }),

      // Hydration tracking
      setHasHydrated: (hydrated) => set({ hasHydrated: hydrated }),

      // DKG key management— persist in zustand store (localStorage)
      storeDkgResult: (publicKey, result) =>
        set((state) => ({
          dkgResults: { ...state.dkgResults, [publicKey]: result },
        })),
      getDkgResult: (publicKey) => {
        return get().dkgResults[publicKey] ?? null;
      },
      storeVaultConfig: (publicKey, config) =>
        set((state) => ({
          vaultConfigs: { ...state.vaultConfigs, [publicKey]: config },
        })),

      refreshBalances: async () => {
        const { activeAccount, network } = get();
        if (!activeAccount) return;

        set({ isLoading: true, error: null });
        try {
          const connection = createConnection(network);
          const pubkey = new PublicKey(activeAccount.publicKey);

          const tokens = await fetchTokenBalances(connection, pubkey);
          const symbols = tokens.map((t) => t.symbol);
          const prices = await fetchTokenPrices(symbols);

          const enriched = tokens.map((t) => {
            const price = prices[t.symbol];
            if (price) {
              return {
                ...t,
                usdPrice: price.usd,
                usdValue: t.balance * price.usd,
                change24h: price.change24h,
              };
            }
            return t;
          });

          const solToken = enriched.find((t) => t.symbol === "SOL");
          const updatedAccount: WalletAccount = {
            ...activeAccount,
            balance: solToken ? solToken.balance : activeAccount.balance,
          };

          set({
            tokens: enriched,
            activeAccount: updatedAccount,
            isLoading: false,
            lastFetchedAt: Date.now(),
          });
        } catch (err) {
          set({
            isLoading: false,
            error: err instanceof Error ? err.message : "Failed to fetch balances",
          });
        }
      },

      refreshTransactions: async () => {
        const { activeAccount, network } = get();
        if (!activeAccount) return;

        try {
          const connection = createConnection(network);
          const pubkey = new PublicKey(activeAccount.publicKey);
          const transactions = await fetchTransactionHistory(connection, pubkey);
          set({ transactions });
        } catch (err) {
          console.warn("Failed to refresh transactions:", err);
        }
      },

      refreshVaultState: async () => {
        const { activeAccount, network } = get();
        if (!activeAccount) return;

        try {
          const client = createVaulkyrieClient(network);
          const pubkey = new PublicKey(activeAccount.publicKey);
          const exists = await client.vaultExists(pubkey);

          if (exists) {
            const result = await client.getVaultRegistry(pubkey);
            if (result) {
              const { account } = result;
              set({
                vaultState: {
                  address: activeAccount.publicKey,
                  threshold: 0,
                  participants: 0,
                  policyConfigHash: Array.from(account.currentAuthorityHash).map(b => b.toString(16).padStart(2, "0")).join(""),
                  authorityLeafIndex: 0,
                  pendingSessions: 0,
                },
              });
            }
          }
        } catch (err) {
          console.warn("No vault found on-chain (expected for new wallets):", err);
        }
      },

      refreshAll: async () => {
        const { refreshBalances, refreshTransactions, refreshVaultState } = get();
        await Promise.all([
          refreshBalances(),
          refreshTransactions(),
          refreshVaultState(),
        ]);
      },
    }),
    {
      name: "vaulkyrie-wallet-storage",
      partialize: (state) => ({
        isOnboarded: state.isOnboarded,
        accounts: state.accounts,
        activeAccount: state.activeAccount,
        network: state.network,
        dkgResults: state.dkgResults,
        vaultConfigs: state.vaultConfigs,
      }),
      onRehydrateStorage: (state) => {
        return () => {
          state.setHasHydrated(true);
        };
      },
    }
  )
);
