import { lazy, Suspense, useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PublicKey } from "@solana/web3.js";
import { Header } from "@/components/layout/Header";
import { BottomNav } from "@/components/layout/BottomNav";
import { ScreenShell } from "@/components/layout/ScreenShell";
import { Card } from "@/components/ui/card";
import { Dashboard } from "@/pages/Dashboard";
import { QuantumVault } from "@/pages/QuantumVault";
import { SendView } from "@/components/wallet/SendView";
import { ReceiveView } from "@/components/wallet/ReceiveView";
import { SwapView } from "@/components/wallet/SwapView";
import { RecoveryView } from "@/components/wallet/RecoveryView";
import { ActivityList } from "@/components/wallet/ActivityList";
import { AddressBook } from "@/components/wallet/AddressBook";
import { SettingsView } from "@/components/settings/SettingsView";
import { ApprovalCenter } from "@/components/extension/ApprovalCenter";
import { OnboardingWelcome } from "@/components/onboarding/OnboardingWelcome";
import { PrivacyVaultSetup } from "@/components/onboarding/PrivacyVaultSetup";
import { RestoreVaultStep } from "@/components/onboarding/RestoreVaultStep";
import { VaultConfigStep } from "@/components/onboarding/VaultConfigStep";
import { LockScreen } from "@/components/onboarding/LockScreen";
import { DKGCeremony } from "@/components/ceremony/DKGCeremony";
import { JoinCeremony } from "@/components/ceremony/JoinCeremony";
import { getWalletAccountKind } from "@/lib/walletAccounts";
import { hasWalletSessionPassword } from "@/lib/walletSession";
import { migrateSensitiveRecordsInBackground } from "@/lib/internalWalletRpc";
import { useWalletStore } from "@/store/walletStore";
import type { VaultConfig } from "@/components/onboarding/VaultConfigStep";
import type { WalletView } from "@/types";
import "./index.css";

const PrivacyView = lazy(() =>
  import("@/components/wallet/PrivacyView").then((module) => ({ default: module.PrivacyView })),
);

function App() {
  const {
    activeAccount,
    isOnboarded,
    hasHydrated,
    transactions,
    network,
    passwordHash,
    isLocked: storeLocked,
    securityPreferences,
    setOnboarded,
    setActiveAccount,
    addAccount,
    storeDkgResult,
    storeVaultConfig,
    setNetwork,
    setLocked: setStoreLocked,
    refreshAll,
  } = useWalletStore();

  const [view, setView] = useState<WalletView>("onboarding");
  const [isLocked, setIsLocked] = useState(false);
  const [hasResolvedSession, setHasResolvedSession] = useState(false);
  const [vaultConfig, setVaultConfig] = useState<VaultConfig | null>(null);
  const activeAccountKind = getWalletAccountKind(activeAccount);

  const requestedView =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "approval"
      ? "approval"
      : null;

  // Sync view after zustand persist hydration completes
  useEffect(() => {
    if (!hasHydrated) return;
    let cancelled = false;

    void (async () => {
      try {
        const hasSessionPassword = await hasWalletSessionPassword();
        if (cancelled) {
          return;
        }

        const shouldLock = isOnboarded && (!passwordHash || storeLocked || !hasSessionPassword);
        if (shouldLock) {
          setIsLocked(true);
          setView("lock");
        } else {
          await migrateSensitiveRecordsInBackground().catch((error) => {
            console.warn("Failed to migrate Vaulkyrie sensitive records.", error);
          });
          setIsLocked(false);
          setView(isOnboarded ? (requestedView ?? "dashboard") : "onboarding");
        }
      } catch (error) {
        console.error("Failed to resolve Vaulkyrie session state.", error);
        if (cancelled) {
          return;
        }
        setIsLocked(Boolean(isOnboarded));
        setView(isOnboarded ? "lock" : "onboarding");
      }
      setHasResolvedSession(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [hasHydrated, isOnboarded, passwordHash, requestedView, storeLocked]);

  // Sync local lock state when store's isLocked changes (e.g. from Settings → Lock Wallet)
  useEffect(() => {
    if (!(storeLocked && !isLocked && hasHydrated && isOnboarded)) return;

    const timer = window.setTimeout(() => {
      setIsLocked(true);
      setView("lock");
    }, 0);

    return () => window.clearTimeout(timer);
  }, [hasHydrated, isLocked, isOnboarded, storeLocked]);

  // Auto-lock after the configured inactivity window
  useEffect(() => {
    if (!isOnboarded || !passwordHash || isLocked) return;

    let timeout: ReturnType<typeof setTimeout>;
    const autoLockMs = securityPreferences.autoLockMinutes * 60 * 1000;

    const resetTimer = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        setIsLocked(true);
        setStoreLocked(true);
        setView("lock");
      }, autoLockMs);
    };

    const events = ["mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((e) => window.addEventListener(e, resetTimer));
    resetTimer();

    return () => {
      clearTimeout(timeout);
      events.forEach((e) => window.removeEventListener(e, resetTimer));
    };
  }, [isOnboarded, passwordHash, isLocked, securityPreferences.autoLockMinutes, setStoreLocked]);

  useEffect(() => {
    if (!isOnboarded || !passwordHash || isLocked || !securityPreferences.lockOnHide) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      setIsLocked(true);
      setStoreLocked(true);
      setView("lock");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [isOnboarded, passwordHash, isLocked, securityPreferences.lockOnHide, setStoreLocked]);

  // Show splash screen until store has hydrated
  if (!hasHydrated || !hasResolvedSession) {
    return (
      <div className="flex flex-col h-screen bg-background text-foreground items-center justify-center gap-4">
        <div className="w-12 h-12 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
        <p className="text-muted-foreground text-sm">Loading vault…</p>
      </div>
    );
  }

  const isFullScreen =
    view === "onboarding" ||
    view === "import-vault" ||
    view === "vault-config" ||
    view === "privacy-vault-setup" ||
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
      kind: "threshold-vault" as const,
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
          participantId: parsed.participantId,
          isMultiDevice: parsed.isMultiDevice,
          cosigner: parsed.cosigner ?? null,
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
        cosignerEnabled: vaultConfig.cosigner?.enabled === true,
        cosignerParticipantId: vaultConfig.cosigner?.participantId ?? null,
      });
    }

    addAccount(account);
    setActiveAccount(account);
    setOnboarded(true);
    setStoreLocked(false);
    setView("dashboard");
    void refreshAll();
  };

  const handlePrivacyVaultCreated = () => {
    setIsLocked(false);
    setStoreLocked(false);
    setView("dashboard");
    void refreshAll();
  };

  const renderThresholdOnlyView = (title: string, description: string) => (
    <ScreenShell
      title={title}
      description={description}
      onBack={() => setView("dashboard")}
      backLabel="Back to dashboard"
    >
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium">Threshold Vault required</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          This flow depends on Vaulkyrie threshold custody and coordination state. Switch to a
          Threshold Vault from the account menu to use it.
        </p>
      </Card>
    </ScreenShell>
  );

  const renderView = () => {
    if (isLocked) {
      return (
        <LockScreen
            onUnlock={() => {
              setIsLocked(false);
              setStoreLocked(false);
              setView(requestedView ?? "dashboard");
            }}
          />
        );
    }

    switch (view) {
      case "onboarding":
        return (
          <OnboardingWelcome
            onCreateVault={() => setView("vault-config")}
            onCreatePrivacyVault={() => setView("privacy-vault-setup")}
            onImportVault={() => setView("import-vault")}
            onJoinCeremony={() => setView("join-ceremony")}
          />
        );

      case "import-vault":
        return (
          <RestoreVaultStep
            onBack={() => setView("onboarding")}
            onRestored={() => {
              setOnboarded(true);
              setIsLocked(true);
              setStoreLocked(true);
              setView("lock");
            }}
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

      case "privacy-vault-setup":
        return (
          <PrivacyVaultSetup
            onBack={() => setView(isOnboarded ? "dashboard" : "onboarding")}
            onComplete={handlePrivacyVaultCreated}
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
        if (activeAccountKind === "privacy-vault") {
          return renderThresholdOnlyView(
            "Threshold sending only",
            "Public send orchestration still uses Vaulkyrie threshold custody. Use Privacy for Umbra transfers or switch to a Threshold Vault.",
          );
        }
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

      case "privacy":
        return (
          <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading privacy mode...</div>}>
            <PrivacyView onNavigate={setView} />
          </Suspense>
        );

      case "swap":
        return (
          <SwapView
            balance={activeAccount?.balance ?? 0}
            onNavigate={setView}
          />
        );

      case "quantum-vault":
        if (activeAccountKind === "privacy-vault") {
          return renderThresholdOnlyView(
            "PQC admin only",
            "Post-quantum authority management belongs to Threshold Vaults. Privacy Vaults keep a normal local signer for private wallet flows.",
          );
        }
        return (
          <QuantumVault
            walletAddress={activeAccount?.publicKey ?? ""}
            onNavigate={setView}
          />
        );

      case "activity":
        return (
          <ScreenShell
            title="Activity"
            description="Recent wallet transactions and coordinated sends."
            onBack={() => setView("dashboard")}
            backLabel="Back to dashboard"
          >
            <ActivityList transactions={transactions} />
          </ScreenShell>
        );

      case "settings":
        return (
          <SettingsView
            network={network}
            onNavigate={setView}
          />
        );

      case "recovery":
        return <RecoveryView onNavigate={setView} />;

      case "contacts":
        return <AddressBook onNavigate={setView} />;

      case "approval":
        return <ApprovalCenter onNavigate={setView} />;

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
          onCreatePrivacyVault={() => setView("privacy-vault-setup")}
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
