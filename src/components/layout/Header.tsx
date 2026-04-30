import { ChevronDown, Copy, Check, Plus, Shield, Wallet } from "lucide-react";
import { useState } from "react";
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
}

export function Header({
  accountName,
  address,
  network,
  onNetworkChange,
  onCreateVault,
  onCreatePrivacyVault,
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

  return (
    <header className="flex items-center justify-between gap-3 border-b border-border/70 bg-card/75 px-4 py-3 backdrop-blur-md">
      {/* Account info with vault selector */}
      <div className="flex items-center gap-2.5 min-w-0 relative">
        <div className="h-9 w-9 rounded-2xl overflow-hidden border border-border/60 shadow-sm shadow-primary/20 shrink-0">
          <img src={logo} alt="V" className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0 space-y-1">
          <button
            onClick={() => setShowVaults(!showVaults)}
            className="flex items-center gap-1 text-sm font-semibold truncate hover:text-primary transition-colors cursor-pointer"
          >
            {accountName}
            <span className="rounded-full border border-border/80 bg-background/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {selectedAccountLabel}
            </span>
            {accounts.length > 1 && <ChevronDown className="h-3 w-3 text-muted-foreground" />}
          </button>
          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors cursor-pointer"
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
              className="fixed inset-0 z-40"
              onClick={() => setShowVaults(false)}
            />
            <div className="absolute left-0 top-full mt-2 z-50 min-w-[220px] rounded-2xl border border-border/80 bg-popover/95 p-1.5 shadow-2xl backdrop-blur">
              {accounts.map((acc) => {
                return (
                  <button
                    key={acc.publicKey}
                    onClick={() => {
                      switchVault(acc.publicKey);
                      setShowVaults(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 w-full px-2.5 py-2.5 rounded-xl text-xs transition-colors cursor-pointer",
                      acc.publicKey === address
                        ? "bg-accent text-accent-foreground"
                        : "text-popover-foreground hover:bg-accent/60",
                    )}
                  >
                    <Wallet className="h-3.5 w-3.5 shrink-0" />
                    <div className="min-w-0 text-left">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">
                          {vaultConfigs[acc.publicKey]?.vaultName ?? acc.name}
                        </p>
                        <span className="rounded-full border border-border/80 bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground">
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
              {(onCreateVault || onCreatePrivacyVault) && (
                <>
                  <div className="border-t border-border my-1" />
                  {onCreateVault && (
                    <button
                      onClick={() => {
                        setShowVaults(false);
                        onCreateVault();
                      }}
                      className="flex items-center gap-2 w-full px-2.5 py-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors cursor-pointer"
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
                      className="flex items-center gap-2 w-full px-2.5 py-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors cursor-pointer"
                    >
                      <Shield className="h-3.5 w-3.5" />
                      Create privacy vault
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
          onClick={() => setShowNetworks(!showNetworks)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-colors cursor-pointer",
            "border-border/80 bg-background/60 hover:bg-accent/70",
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
              className="fixed inset-0 z-40"
              onClick={() => setShowNetworks(false)}
            />
            <div className="absolute right-0 top-full mt-2 z-50 min-w-[156px] rounded-2xl border border-border/80 bg-popover/95 p-1.5 shadow-2xl backdrop-blur">
              {(Object.keys(NETWORKS) as NetworkId[]).map((id) => (
                <button
                  key={id}
                  onClick={() => {
                    onNetworkChange(id);
                    setShowNetworks(false);
                  }}
                  className={cn(
                    "flex items-center gap-2 w-full px-2.5 py-2 rounded-xl text-xs transition-colors cursor-pointer",
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
