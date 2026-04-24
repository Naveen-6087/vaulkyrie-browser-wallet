import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PublicKey } from "@solana/web3.js";
import { Header } from "@/components/layout/Header";
import { BottomNav } from "@/components/layout/BottomNav";
import { Dashboard } from "@/pages/Dashboard";
import { QuantumVault } from "@/pages/QuantumVault";
import { SendView } from "@/components/wallet/SendView";
import { ReceiveView } from "@/components/wallet/ReceiveView";
import { SwapView } from "@/components/wallet/SwapView";
import { PolicyView } from "@/components/wallet/PolicyView";
import { ActivityList } from "@/components/wallet/ActivityList";
import { AddressBook } from "@/components/wallet/AddressBook";
import { SettingsView } from "@/components/settings/SettingsView";
import { OnboardingWelcome } from "@/components/onboarding/OnboardingWelcome";
import { VaultConfigStep } from "@/components/onboarding/VaultConfigStep";
import { LockScreen } from "@/components/onboarding/LockScreen";
import { DKGCeremony } from "@/components/ceremony/DKGCeremony";
import { JoinCeremony } from "@/components/ceremony/JoinCeremony";
import { useWalletStore } from "@/store/walletStore";
import type { VaultConfig } from "@/components/onboarding/VaultConfigStep";
import type { WalletView } from "@/types";
import "./index.css";

function App() {
  const {
    activeAccount,
    isOnboarded,
    hasHydrated,
    transactions,
    network,
    passwordHash,
    isLocked: storeLocked,
    setOnboarded,
    setActiveAccount,
    addAccount,
    storeDkgResult,
    storeVaultConfig,
    setNetwork,
    setLocked: setStoreLocked,
  } = useWalletStore();

  const [view, setView] = useState<WalletView>("onboarding");
  const [isLocked, setIsLocked] = useState(false);
  const [vaultConfig, setVaultConfig] = useState<VaultConfig | null>(null);

  // Sync view after zustand persist hydration completes
  useEffect(() => {
    if (!hasHydrated) return;

    const timer = window.setTimeout(() => {
      if (isOnboarded && passwordHash && storeLocked) {
        setIsLocked(true);
        setView("lock");
      } else if (isOnboarded && !passwordHash) {
        setIsLocked(true);
        setView("lock");
      } else {
        setView(isOnboarded ? "dashboard" : "onboarding");
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [hasHydrated, isOnboarded, passwordHash, storeLocked]);

  // Sync local lock state when store's isLocked changes (e.g. from Settings → Lock Wallet)
  useEffect(() => {
    if (!(storeLocked && !isLocked && hasHydrated && isOnboarded)) return;

    const timer = window.setTimeout(() => {
      setIsLocked(true);
      setView("lock");
    }, 0);

    return () => window.clearTimeout(timer);
  }, [hasHydrated, isLocked, isOnboarded, storeLocked]);

  // Auto-lock after 5 minutes of inactivity
  useEffect(() => {
    if (!isOnboarded || !passwordHash || isLocked) return;

    let timeout: ReturnType<typeof setTimeout>;
    const AUTO_LOCK_MS = 5 * 60 * 1000;

    const resetTimer = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        setIsLocked(true);
        setStoreLocked(true);
        setView("lock");
      }, AUTO_LOCK_MS);
    };

    const events = ["mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((e) => window.addEventListener(e, resetTimer));
    resetTimer();

    return () => {
      clearTimeout(timeout);
      events.forEach((e) => window.removeEventListener(e, resetTimer));
    };
  }, [isOnboarded, passwordHash, isLocked, setStoreLocked]);

  // Show splash screen until store has hydrated
  if (!hasHydrated) {
    return (
      <div className="flex flex-col h-screen bg-background text-foreground items-center justify-center gap-4">
        <div className="w-12 h-12 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
        <p className="text-muted-foreground text-sm">Loading vault…</p>
      </div>
    );
  }

  const isFullScreen =
    view === "onboarding" ||
    view === "vault-config" ||
    view === "dkg-ceremony" ||
    view === "join-ceremony" ||
    view === "lock";

  const handleDKGComplete = (groupPublicKey?: string) => {
    let solanaAddress = groupPublicKey ?? "No key generated";
    if (groupPublicKey && /^[0-9a-fA-F]{64}$/.test(groupPublicKey)) {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(groupPublicKey.slice(i * 2, i * 2 + 2), 16);
      }
      solanaAddress = new PublicKey(bytes).toBase58();
    }
    const account = {
      name: vaultConfig?.vaultName ?? "Main Vault",
      publicKey: solanaAddress,
      balance: 0,
      isActive: true,
    };

    // Migrate DKG result from sessionStorage to persistent zustand store
    const dkgRaw = sessionStorage.getItem("vaulkyrie_dkg_result");
    if (dkgRaw) {
      try {
        const parsed = JSON.parse(dkgRaw);
        storeDkgResult(solanaAddress, {
          groupPublicKeyHex: parsed.groupPublicKeyHex ?? groupPublicKey ?? "",
          publicKeyPackage: parsed.publicKeyPackage ?? "",
          keyPackages: parsed.keyPackages ?? {},
          threshold: parsed.threshold ?? vaultConfig?.threshold ?? 2,
          participants: parsed.participants ?? vaultConfig?.totalParticipants ?? 3,
          createdAt: Date.now(),
        });
        sessionStorage.removeItem("vaulkyrie_dkg_result");
      } catch {
        console.warn("Failed to migrate DKG result from sessionStorage");
      }
    }

    if (vaultConfig) {
      storeVaultConfig(solanaAddress, {
        vaultName: vaultConfig.vaultName,
        threshold: vaultConfig.threshold,
        totalParticipants: vaultConfig.totalParticipants,
      });
    }

    addAccount(account);
    setActiveAccount(account);
    setOnboarded(true);
    setStoreLocked(false);
    setView("dashboard");
  };

  const renderView = () => {
    if (isLocked) {
      return (
        <LockScreen
          onUnlock={() => {
            setIsLocked(false);
            setStoreLocked(false);
            setView("dashboard");
          }}
        />
      );
    }

    switch (view) {
      case "onboarding":
        return (
          <OnboardingWelcome
            onCreateVault={() => setView("vault-config")}
            onImportVault={() => {
              setOnboarded(true);
              setView("dashboard");
            }}
            onJoinCeremony={() => setView("join-ceremony")}
          />
        );

      case "vault-config":
        return (
          <VaultConfigStep
            onNext={(config) => {
              setVaultConfig(config);
              setView("dkg-ceremony");
            }}
            onBack={() => setView("onboarding")}
          />
        );

      case "dkg-ceremony":
        return (
          <DKGCeremony
            config={vaultConfig ?? { vaultName: "Main Vault", threshold: 2, totalParticipants: 3 }}
            onComplete={handleDKGComplete}
            onBack={() => setView("vault-config")}
          />
        );

      case "join-ceremony":
        return (
          <JoinCeremony
            onComplete={handleDKGComplete}
            onBack={() => setView("onboarding")}
          />
        );

      case "dashboard":
        return <Dashboard onNavigate={setView} />;

      case "send":
        return (
          <SendView
            balance={activeAccount?.balance ?? 0}
            onNavigate={setView}
          />
        );

      case "receive":
        return (
          <ReceiveView
            address={activeAccount?.publicKey ?? ""}
            onNavigate={setView}
          />
        );

      case "swap":
        return (
          <SwapView
            balance={activeAccount?.balance ?? 0}
            onNavigate={setView}
          />
        );

      case "quantum-vault":
        return (
          <QuantumVault
            walletAddress={activeAccount?.publicKey ?? ""}
            onNavigate={setView}
          />
        );

      case "activity":
        return (
          <div className="flex flex-col gap-4 p-4 flex-1">
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => setView("dashboard")}
                className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
              >
                ← Back
              </button>
              <h2 className="text-lg font-semibold flex-1 text-center mr-8">
                Activity
              </h2>
            </div>
            <ActivityList transactions={transactions} />
          </div>
        );

      case "settings":
        return (
          <SettingsView
            network={network}
            onNavigate={setView}
          />
        );

      case "contacts":
        return <AddressBook />;

      case "policy":
        return <PolicyView onNavigate={setView} />;

      default:
        return <Dashboard onNavigate={setView} />;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {!isFullScreen && (
        <Header
          accountName={activeAccount?.name ?? vaultConfig?.vaultName ?? "Main Wallet"}
          address={activeAccount?.publicKey ?? ""}
          network={network}
          onNetworkChange={setNetwork}
          onCreateVault={() => setView("vault-config")}
        />
      )}

      <main className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="h-full"
          >
            {renderView()}
          </motion.div>
        </AnimatePresence>
      </main>

      {!isFullScreen && <BottomNav active={view} onNavigate={setView} />}
    </div>
  );
}

export default App;
