import { ChevronDown, Copy, Check, Plus, Radio, Shield, Upload, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { getWalletAccountLabel } from "@/lib/walletAccounts";
import { cn, shortenAddress } from "@/lib/utils";
import { NETWORKS } from "@/lib/constants";
import { useWalletStore } from "@/store/walletStore";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import type { NetworkId } from "@/types";
import logo from "@/assets/xlogo.jpeg";

interface HeaderProps {
  accountName: string;
  address: string;
  network: NetworkId;
  onNetworkChange: (network: NetworkId) => void;
  onCreateVault?: () => void;
  onCreatePrivacyVault?: () => void;
  onImportVault?: () => void;
  onJoinCeremony?: () => void;
}

export function Header({
  accountName,
  address,
  network,
  onNetworkChange,
  onCreateVault,
  onCreatePrivacyVault,
  onImportVault,
  onJoinCeremony,
}: HeaderProps) {
  const [showNetworks, setShowNetworks] = useState(false);
  const [showVaults, setShowVaults] = useState(false);
  const { accounts, switchVault, vaultConfigs } = useWalletStore();
  const { copy, isCopied } = useCopyToClipboard({ resetAfterMs: 1500 });
  const selectedAccount = accounts.find((candidate) => candidate.publicKey === address);
  const selectedAccountLabel = getWalletAccountLabel(selectedAccount);

  const handleCopy = async () => {
    await copy(address, "header-address");
  };

  const networkConfig = NETWORKS[network];

  useEffect(() => {
    if (!showNetworks && !showVaults) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setShowNetworks(false);
      setShowVaults(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showNetworks, showVaults]);

  return (
    <header className="relative z-30 flex items-center justify-between gap-3 border-b border-border/70 bg-card/95 px-4 py-3 backdrop-blur-md">
      {/* Account info with vault selector */}
      <div className="flex items-center gap-2.5 min-w-0 relative">
        <div className="h-9 w-9 rounded-2xl overflow-hidden border border-border/60 shadow-sm shadow-primary/20 shrink-0">
          <img src={logo} alt="V" className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0 space-y-1">
          <button
            onClick={() => {
              setShowVaults(!showVaults);
              setShowNetworks(false);
            }}
            className="flex max-w-[240px] items-center gap-1 rounded-lg text-sm font-semibold hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background cursor-pointer"
          >
            <span className="min-w-0 truncate">{accountName}</span>
            <span className="shrink-0 rounded-full border border-border/80 bg-background/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {selectedAccountLabel}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background cursor-pointer"
            aria-live="polite"
          >
            <span className="font-mono">{shortenAddress(address)}</span>
            {isCopied("header-address") ? (
              <Check className="h-3 w-3 text-success" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>

        {/* Vault selector dropdown */}
        {showVaults && (
          <>
            <div
              className="fixed inset-0 z-[70]"
              onClick={() => setShowVaults(false)}
            />
            <div className="fixed left-3 right-3 top-[72px] z-[80] rounded-2xl border border-border/80 bg-popover p-1.5 shadow-2xl">
              <div className="max-h-[min(340px,calc(100vh-148px))] overflow-y-auto pr-1">
                {accounts.map((acc) => {
                  return (
                    <button
                      key={acc.publicKey}
                      onClick={() => {
                        switchVault(acc.publicKey);
                        setShowVaults(false);
                      }}
                      className={cn(
                        "flex min-h-12 w-full items-center gap-2 rounded-xl px-2.5 py-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover cursor-pointer",
                        acc.publicKey === address
                          ? "bg-accent text-accent-foreground"
                          : "text-popover-foreground hover:bg-accent/60",
                      )}
                    >
                      <Wallet className="h-3.5 w-3.5 shrink-0" />
                      <div className="min-w-0 flex-1 text-left">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate font-medium">
                            {vaultConfigs[acc.publicKey]?.vaultName ?? acc.name}
                          </p>
                          <span className="shrink-0 rounded-full border border-border/80 bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground">
                            {getWalletAccountLabel(acc)}
                          </span>
                        </div>
                        <p className="font-mono text-muted-foreground">
                          {shortenAddress(acc.publicKey)}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
              {(onCreateVault || onCreatePrivacyVault || onImportVault || onJoinCeremony) && (
                <>
                  <div className="border-t border-border my-1" />
                  {onCreateVault && (
                    <button
                      onClick={() => {
                        setShowVaults(false);
                        onCreateVault();
                      }}
                      className="flex min-h-10 items-center gap-2 w-full px-2.5 py-2 rounded-xl text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover cursor-pointer"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create threshold vault
                    </button>
                  )}
                  {onCreatePrivacyVault && (
                    <button
                      onClick={() => {
                        setShowVaults(false);
                        onCreatePrivacyVault();
                      }}
                      className="flex min-h-10 items-center gap-2 w-full px-2.5 py-2 rounded-xl text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover cursor-pointer"
                    >
                      <Shield className="h-3.5 w-3.5" />
                      Create privacy vault
                    </button>
                  )}
                  {onJoinCeremony && (
                    <button
                      onClick={() => {
                        setShowVaults(false);
                        onJoinCeremony();
                      }}
                      className="flex min-h-10 items-center gap-2 w-full px-2.5 py-2 rounded-xl text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover cursor-pointer"
                    >
                      <Radio className="h-3.5 w-3.5" />
                      Join ceremony
                    </button>
                  )}
                  {onImportVault && (
                    <button
                      onClick={() => {
                        setShowVaults(false);
                        onImportVault();
                      }}
                      className="flex min-h-10 items-center gap-2 w-full px-2.5 py-2 rounded-xl text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover cursor-pointer"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Import existing vault
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Network selector */}
      <div className="relative">
        <button
          onClick={() => {
            setShowNetworks(!showNetworks);
            setShowVaults(false);
          }}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-colors cursor-pointer",
            "border-border/80 bg-background/60 hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: networkConfig.color }}
          />
          {networkConfig.name}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>

        {showNetworks && (
          <>
            <div
              className="fixed inset-0 z-[70]"
              onClick={() => setShowNetworks(false)}
            />
            <div className="fixed right-3 top-[72px] z-[80] min-w-[156px] rounded-2xl border border-border/80 bg-popover p-1.5 shadow-2xl">
              {(Object.keys(NETWORKS) as NetworkId[]).map((id) => (
                <button
                  key={id}
                  onClick={() => {
                    onNetworkChange(id);
                    setShowNetworks(false);
                  }}
                  className={cn(
                    "flex min-h-10 items-center gap-2 w-full px-2.5 py-2 rounded-xl text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover cursor-pointer",
                    id === network
                      ? "bg-accent text-accent-foreground"
                      : "text-popover-foreground hover:bg-accent/60",
                  )}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: NETWORKS[id].color }}
                  />
                  {NETWORKS[id].name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </header>
  );
}
