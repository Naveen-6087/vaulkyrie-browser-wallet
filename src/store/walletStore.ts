import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PublicKey } from "@solana/web3.js";
import type {
  WalletAccount,
  Token,
  Transaction,
  Collectible,
  VaultState,
  WalletView,
  PolicyProfile,
  PendingPolicyRequest,
} from "../types";
import { DEFAULT_NETWORK, type NetworkId } from "../lib/constants";
import {
  createVaulkyrieClient,
  fetchTokenBalances,
  fetchTransactionHistory,
  fetchCollectibles,
  fetchTokenPrices,
  withRpcFallback,
} from "../services/solanaRpc";
import { walletPersistStorage } from "../lib/walletPersistStorage";

// Per-vault DKG key material stored in localStorage
interface StoredDkgResult {
  groupPublicKeyHex: string;
  publicKeyPackage: string;
  keyPackages: Record<number, string>;
  threshold: number;
  participants: number;
  createdAt: number;
  /** Which participant this device was during DKG */
  participantId?: number;
  /** Whether the vault was created via multi-device ceremony */
  isMultiDevice?: boolean;
}

interface VaultConfigPersist {
  vaultName: string;
  threshold: number;
  totalParticipants: number;
}

interface Contact {
  name: string;
  address: string;
  addedAt: number;
}

interface SecurityPreferences {
  autoLockMinutes: 5 | 15 | 30 | 60;
  lockOnHide: boolean;
}

export interface PersistedWalletState {
  isOnboarded: boolean;
  isLocked: boolean;
  accounts: WalletAccount[];
  activeAccount: WalletAccount | null;
  network: NetworkId;
  relayUrl: string;
  dkgResults: Record<string, StoredDkgResult>;
  vaultConfigs: Record<string, VaultConfigPersist>;
  passwordHash: string | null;
  passwordSalt: string | null;
  failedUnlockAttempts: number;
  lastUnlockFailureAt: number | null;
  unlockBlockedUntil: number | null;
  securityPreferences: SecurityPreferences;
  contacts: Contact[];
  xmssTrees: Record<string, string>;
  quantumVaultKeys: Record<string, string>;
  policyProfiles: Record<string, PolicyProfile[]>;
}

interface WalletState extends PersistedWalletState {
  // Auth
  hasHydrated: boolean;

  // Password (PBKDF2 hash + salt, hex-encoded)
  // In-memory handoff from SendView to PolicyView
  pendingPolicyRequest: PendingPolicyRequest | null;

  // Tokens & transactions (real data from RPC)
  tokens: Token[];
  transactions: Transaction[];
  collectibles: Collectible[];

  // Vault state (Vaulkyrie on-chain accounts)
  vaultState: VaultState | null;

  // Network
  network: NetworkId;
  relayUrl: string;

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
  setCollectibles: (collectibles: Collectible[]) => void;
  setVaultState: (state: VaultState | null) => void;
  setNetwork: (network: NetworkId) => void;
  setRelayUrl: (relayUrl: string) => void;
  setCurrentView: (view: WalletView) => void;
  clearError: () => void;

  // Hydration
  setHasHydrated: (hydrated: boolean) => void;

  // Password management
  setPasswordHash: (hash: string, salt: string) => void;
  hasPassword: () => boolean;
  registerUnlockFailure: () => { attempts: number; blockedUntil: number | null };
  resetUnlockFailures: () => void;
  updateSecurityPreferences: (preferences: Partial<SecurityPreferences>) => void;

  // DKG key management
  storeDkgResult: (publicKey: string, result: StoredDkgResult) => void;
  getDkgResult: (publicKey: string) => StoredDkgResult | null;
  storeVaultConfig: (publicKey: string, config: VaultConfigPersist) => void;

  // Address book
  addContact: (contact: Omit<Contact, "addedAt">) => void;
  removeContact: (address: string) => void;
  getContacts: () => Contact[];

  // XMSS tree persistence
  storeXmssTree: (publicKey: string, serialized: string) => void;
  getXmssTree: (publicKey: string) => string | null;
  clearXmssTree: (publicKey: string) => void;
  storeQuantumVaultKey: (publicKey: string, serialized: string) => void;
  getQuantumVaultKey: (publicKey: string) => string | null;
  clearQuantumVaultKey: (publicKey: string) => void;

  // Policy profile persistence
  upsertPolicyProfile: (publicKey: string, profile: PolicyProfile) => void;
  deletePolicyProfile: (publicKey: string, profileId: string) => void;
  getPolicyProfiles: (publicKey: string) => PolicyProfile[];
  setPendingPolicyRequest: (request: PendingPolicyRequest | null) => void;

  // Async actions — real Solana RPC calls
  refreshBalances: () => Promise<void>;
  refreshTransactions: () => Promise<void>;
  refreshCollectibles: () => Promise<void>;
  refreshVaultState: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export function pickPersistedWalletState(state: WalletState): PersistedWalletState {
  return {
    isOnboarded: state.isOnboarded,
    isLocked: state.isLocked,
    accounts: state.accounts,
    activeAccount: state.activeAccount,
    network: state.network,
    relayUrl: state.relayUrl,
    dkgResults: state.dkgResults,
    vaultConfigs: state.vaultConfigs,
    passwordHash: state.passwordHash,
    passwordSalt: state.passwordSalt,
    failedUnlockAttempts: state.failedUnlockAttempts,
    lastUnlockFailureAt: state.lastUnlockFailureAt,
    unlockBlockedUntil: state.unlockBlockedUntil,
    securityPreferences: state.securityPreferences,
    contacts: state.contacts,
    xmssTrees: state.xmssTrees,
    quantumVaultKeys: state.quantumVaultKeys,
    policyProfiles: state.policyProfiles,
  };
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      isLocked: true,
      isOnboarded: false,
      hasHydrated: false,
      passwordHash: null,
      passwordSalt: null,
      failedUnlockAttempts: 0,
      lastUnlockFailureAt: null,
      unlockBlockedUntil: null,
      securityPreferences: {
        autoLockMinutes: 5,
        lockOnHide: true,
      },
      activeAccount: null,
      accounts: [],
      dkgResults: {},
      vaultConfigs: {},
      contacts: [],
      xmssTrees: {},
      quantumVaultKeys: {},
      policyProfiles: {},
      pendingPolicyRequest: null,
      tokens: [],
      transactions: [],
      collectibles: [],
      vaultState: null,
      network: DEFAULT_NETWORK,
      relayUrl: import.meta.env.VITE_RELAY_URL ?? "ws://localhost:8765",
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
            error: null,
            isLoading: false,
            tokens: [],
            transactions: [],
            collectibles: [],
            vaultState: null,
            lastFetchedAt: null,
          });
        }
      },
      setTokens: (tokens) => set({ tokens }),
      setTransactions: (transactions) => set({ transactions }),
      setCollectibles: (collectibles) => set({ collectibles }),
      setVaultState: (vaultState) => set({ vaultState }),
      setNetwork: (network) => set({
        network,
        error: null,
        isLoading: false,
        tokens: [],
        transactions: [],
        collectibles: [],
        vaultState: null,
        lastFetchedAt: null,
      }),
      setRelayUrl: (relayUrl) => set({ relayUrl }),
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

      // Password management
      setPasswordHash: (hash, salt) =>
        set({ passwordHash: hash, passwordSalt: salt }),
      hasPassword: () => {
        return get().passwordHash !== null;
      },
      registerUnlockFailure: () => {
        const now = Date.now();
        const state = get();
        const isRecent = state.lastUnlockFailureAt !== null && now - state.lastUnlockFailureAt < 10 * 60 * 1000;
        const attempts = (isRecent ? state.failedUnlockAttempts : 0) + 1;
        const cooldownMs = attempts >= 5 ? 5 * 60 * 1000 : attempts === 4 ? 60 * 1000 : attempts === 3 ? 30 * 1000 : 0;
        const blockedUntil = cooldownMs > 0 ? now + cooldownMs : null;

        set({
          failedUnlockAttempts: attempts,
          lastUnlockFailureAt: now,
          unlockBlockedUntil: blockedUntil,
        });

        return { attempts, blockedUntil };
      },
      resetUnlockFailures: () =>
        set({
          failedUnlockAttempts: 0,
          lastUnlockFailureAt: null,
          unlockBlockedUntil: null,
        }),
      updateSecurityPreferences: (preferences) =>
        set((state) => ({
          securityPreferences: {
            ...state.securityPreferences,
            ...preferences,
          },
        })),

      // Address book
      addContact: (contact) =>
        set((state) => ({
          contacts: [
            ...state.contacts.filter((c) => c.address !== contact.address),
            { ...contact, addedAt: Date.now() },
          ],
        })),
      removeContact: (address) =>
        set((state) => ({
          contacts: state.contacts.filter((c) => c.address !== address),
        })),
      getContacts: () => get().contacts,

      // XMSS tree persistence
      storeXmssTree: (publicKey, serialized) =>
        set((state) => ({
          xmssTrees: { ...state.xmssTrees, [publicKey]: serialized },
        })),
      getXmssTree: (publicKey) => get().xmssTrees[publicKey] ?? null,
      clearXmssTree: (publicKey) =>
        set((state) => {
          const next = { ...state.xmssTrees };
          delete next[publicKey];
          return { xmssTrees: next };
        }),
      storeQuantumVaultKey: (publicKey, serialized) =>
        set((state) => ({
          quantumVaultKeys: { ...state.quantumVaultKeys, [publicKey]: serialized },
        })),
      getQuantumVaultKey: (publicKey) => get().quantumVaultKeys[publicKey] ?? null,
      clearQuantumVaultKey: (publicKey) =>
        set((state) => {
          const next = { ...state.quantumVaultKeys };
          delete next[publicKey];
          return { quantumVaultKeys: next };
        }),

      upsertPolicyProfile: (publicKey, profile) =>
        set((state) => {
          const existing = state.policyProfiles[publicKey] ?? [];
          const next = existing.some((item) => item.id === profile.id)
            ? existing.map((item) => (item.id === profile.id ? profile : item))
            : [profile, ...existing];
          return {
            policyProfiles: {
              ...state.policyProfiles,
              [publicKey]: next,
            },
          };
        }),
      deletePolicyProfile: (publicKey, profileId) =>
        set((state) => ({
          policyProfiles: {
            ...state.policyProfiles,
            [publicKey]: (state.policyProfiles[publicKey] ?? []).filter((item) => item.id !== profileId),
          },
        })),
      getPolicyProfiles: (publicKey) => get().policyProfiles[publicKey] ?? [],
      setPendingPolicyRequest: (pendingPolicyRequest) => set({ pendingPolicyRequest }),

      refreshBalances: async () => {
        const { activeAccount, network } = get();
        if (!activeAccount) return;

        set({ isLoading: true, error: null });
        try {
          const pubkey = new PublicKey(activeAccount.publicKey);
          const tokens = await withRpcFallback(network, (connection) =>
            fetchTokenBalances(connection, pubkey),
          );
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
          const pubkey = new PublicKey(activeAccount.publicKey);
          const transactions = await withRpcFallback(network, (connection) =>
            fetchTransactionHistory(connection, pubkey),
          );
          set({ transactions });
        } catch (err) {
          console.warn("Failed to refresh transactions:", err);
        }
      },

      refreshCollectibles: async () => {
        const { activeAccount, network } = get();
        if (!activeAccount) return;

        try {
          const pubkey = new PublicKey(activeAccount.publicKey);
          const collectibles = await withRpcFallback(network, (connection) =>
            fetchCollectibles(connection, pubkey),
          );
          set({ collectibles });
        } catch (err) {
          console.warn("Failed to refresh collectibles:", err);
        }
      },

      refreshVaultState: async () => {
        const { activeAccount, network, vaultConfigs, dkgResults } = get();
        if (!activeAccount) return;

        try {
          const client = createVaulkyrieClient(network);
          const pubkey = new PublicKey(activeAccount.publicKey);
          const exists = await client.vaultExists(pubkey);

          if (exists) {
            const result = await client.getVaultRegistry(pubkey);
            if (result) {
              const { account } = result;
              const authority = await client.getQuantumAuthority(result.address);
              const localVaultConfig = vaultConfigs[activeAccount.publicKey];
              const localDkg = dkgResults[activeAccount.publicKey];
              set({
                vaultState: {
                  address: activeAccount.publicKey,
                  threshold: localVaultConfig?.threshold ?? localDkg?.threshold ?? 0,
                  participants: localVaultConfig?.totalParticipants ?? localDkg?.participants ?? 0,
                  policyConfigHash: Array.from(account.policyMxeProgram.toBytes()).map((b) => b.toString(16).padStart(2, "0")).join(""),
                  authorityLeafIndex: authority?.account.nextLeafIndex ?? 0,
                  pendingSessions: 0,
                },
              });
              return;
            }
          }
          set({ vaultState: null });
        } catch (err) {
          console.warn("No vault found on-chain (expected for new wallets):", err);
          set({ vaultState: null });
        }
      },

      refreshAll: async () => {
        const { refreshBalances, refreshTransactions, refreshCollectibles, refreshVaultState } = get();
        await Promise.all([
          refreshBalances(),
          refreshTransactions(),
          refreshCollectibles(),
          refreshVaultState(),
        ]);
      },
    }),
    {
      name: "vaulkyrie-wallet-storage",
      storage: walletPersistStorage,
      partialize: (state) => pickPersistedWalletState(state),
      onRehydrateStorage: (state) => {
        return () => {
          state.setHasHydrated(true);
        };
      },
    }
  )
);
