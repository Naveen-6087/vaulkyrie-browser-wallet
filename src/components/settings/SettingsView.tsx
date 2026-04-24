import { Shield, ChevronRight, Globe, Key, Bell, Info, Wallet, Trash2, Users, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWalletStore } from "@/store/walletStore";
import { shortenAddress } from "@/lib/utils";
import type { NetworkId, WalletView } from "@/types";
import { NETWORKS } from "@/lib/constants";
import { probeRelayAvailability, validateRelayUrl } from "@/services/relay/relayAdapter";

interface SettingsViewProps {
  network: NetworkId;
  onNavigate: (view: WalletView) => void;
}

interface SettingRowProps {
  icon: typeof Shield;
  label: string;
  value?: string;
  badge?: string;
  onClick?: () => void;
}

function SettingRow({ icon: Icon, label, value, badge, onClick }: SettingRowProps) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 w-full px-4 py-3 hover:bg-accent/50 transition-colors cursor-pointer"
    >
      <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1 text-left">
        <p className="text-sm font-medium">{label}</p>
        {value && (
          <p className="text-xs text-muted-foreground">{value}</p>
        )}
      </div>
      {badge && <Badge variant="outline">{badge}</Badge>}
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}

export function SettingsView({ network, onNavigate }: SettingsViewProps) {
  const [showAccounts, setShowAccounts] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [relayDraft, setRelayDraft] = useState("");
  const [relayStatus, setRelayStatus] = useState<"checking" | "reachable" | "unreachable">("checking");
  const [relayError, setRelayError] = useState("");
  const {
    accounts,
    activeAccount,
    vaultConfigs,
    switchVault,
    removeAccount,
    setLocked,
    passwordHash,
    securityPreferences,
    relayUrl,
    unlockBlockedUntil,
    setRelayUrl,
    updateSecurityPreferences,
  } = useWalletStore();

  const timeoutOptions: Array<5 | 15 | 30 | 60> = [5, 15, 30, 60];
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const activeCooldown = unlockBlockedUntil !== null && unlockBlockedUntil > currentTime;

  useEffect(() => {
    if (!activeCooldown) return;
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [activeCooldown]);

  useEffect(() => {
    setRelayDraft(relayUrl);
  }, [relayUrl]);

  useEffect(() => {
    const validation = validateRelayUrl(relayUrl);
    if (!validation.ok) {
      setRelayStatus("unreachable");
      setRelayError(validation.error ?? "Invalid relay URL.");
      return;
    }

    let cancelled = false;
    setRelayStatus("checking");
    setRelayError("");

    void probeRelayAvailability(validation.normalizedUrl).then((available) => {
      if (cancelled) return;
      setRelayStatus(available ? "reachable" : "unreachable");
      setRelayError(available ? "" : "Relay unreachable from this browser right now.");
    });

    return () => {
      cancelled = true;
    };
  }, [relayUrl]);

  return (
    <div className="flex flex-col gap-4 p-4 flex-1">
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => onNavigate("dashboard")}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold flex-1 text-center mr-8">
          Settings
        </h2>
      </div>

      <Card className="overflow-hidden divide-y divide-border">
        <SettingRow
          icon={Globe}
          label="Network"
          value={NETWORKS[network].name}
          badge={network}
        />
        <SettingRow
          icon={Key}
          label="Accounts"
          value={`${accounts.length} vault${accounts.length !== 1 ? "s" : ""}`}
          onClick={() => setShowAccounts(!showAccounts)}
        />
        <SettingRow
          icon={Shield}
          label="Security"
          value={`${securityPreferences.autoLockMinutes}m auto-lock · ${securityPreferences.lockOnHide ? "locks on hide" : "stays open in background"}`}
          badge="Active"
          onClick={() => setShowSecurity(!showSecurity)}
        />
        <SettingRow
          icon={Shield}
          label="Policy Engine"
          value="Arcium MXE private evaluation"
          onClick={() => onNavigate("policy")}
        />
        <SettingRow
          icon={Shield}
          label="DApp Approvals"
          value="Review extension connect/sign requests"
          onClick={() => onNavigate("approval")}
        />
        <SettingRow
          icon={Globe}
          label="Cross-device Relay"
          value={relayUrl.replace(/^wss?:\/\//, "")}
        />
        <SettingRow
          icon={Users}
          label="Address Book"
          value="Saved contacts"
          onClick={() => onNavigate("contacts")}
        />
        <SettingRow
          icon={Lock}
          label="Lock Wallet"
          value={passwordHash ? "Password protected" : "Set up password"}
          onClick={() => {
            setLocked(true);
            onNavigate("lock");
          }}
        />
        <SettingRow
          icon={Bell}
          label="Notifications"
          value="Transaction alerts"
        />
        <SettingRow
          icon={Info}
          label="About Vaulkyrie"
          value="v0.1.0 · Solana threshold wallet"
        />
      </Card>

      {showSecurity && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Session protection
            </p>
          </div>
          <div className="space-y-4 p-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Auto-lock timeout</p>
              <div className="grid grid-cols-4 gap-2">
                {timeoutOptions.map((minutes) => {
                  const isActive = securityPreferences.autoLockMinutes === minutes;
                  return (
                    <Button
                      key={minutes}
                      type="button"
                      size="sm"
                      variant={isActive ? "default" : "outline"}
                      aria-pressed={isActive}
                      onClick={() => updateSecurityPreferences({ autoLockMinutes: minutes })}
                    >
                      {minutes}m
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 px-3 py-3">
              <div>
                <p className="text-sm font-medium">Lock when hidden</p>
                <p className="text-xs text-muted-foreground">
                  Locks the wallet when the app loses visibility.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={securityPreferences.lockOnHide ? "default" : "outline"}
                aria-pressed={securityPreferences.lockOnHide}
                onClick={() => updateSecurityPreferences({ lockOnHide: !securityPreferences.lockOnHide })}
              >
                {securityPreferences.lockOnHide ? "On" : "Off"}
              </Button>
            </div>

            <div className="rounded-xl border border-border bg-card/60 px-3 py-3">
              <p className="text-sm font-medium">Unlock backoff</p>
              <p className="mt-1 text-xs text-muted-foreground">
                After repeated failed unlock attempts, Vaulkyrie adds a cooldown before the next try.
              </p>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Status: {activeCooldown ? "Cooldown active" : "No active cooldown"}
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Cross-device relay
          </p>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-xs text-muted-foreground">
            Vaulkyrie connects to a separately deployed relay server for cross-device ceremonies.
            Use a <span className="font-mono">wss://</span> endpoint here for the published
            Chrome extension.
          </p>
          <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Relay health</span>
            <span
              className={
                relayStatus === "reachable"
                  ? "text-emerald-400"
                  : relayStatus === "checking"
                    ? "text-amber-400"
                    : "text-red-400"
              }
            >
              {relayStatus === "reachable"
                ? "Reachable"
                : relayStatus === "checking"
                  ? "Checking…"
                  : "Unavailable"}
            </span>
          </div>
          <input
            value={relayDraft}
            onChange={(event) => setRelayDraft(event.target.value)}
            placeholder="wss://relay.example.com"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          {relayError && (
            <p className="text-xs text-red-400">{relayError}</p>
          )}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              const validation = validateRelayUrl(relayDraft);
              if (!validation.ok) {
                setRelayError(validation.error ?? "Invalid relay URL.");
                return;
              }
              setRelayError("");
              setRelayUrl(validation.normalizedUrl);
            }}
          >
            Save relay URL
          </Button>
        </div>
      </Card>

      {/* Expandable vault list */}
      {showAccounts && (
        <Card className="overflow-hidden divide-y divide-border">
          <div className="px-4 py-2 bg-muted/30">
            <p className="text-xs font-semibold text-muted-foreground">Your Vaults</p>
          </div>
          {accounts.map((acc) => (
            <div
              key={acc.publicKey}
              className="flex items-center gap-3 px-4 py-3"
            >
              <Wallet className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {vaultConfigs[acc.publicKey]?.vaultName ?? acc.name}
                </p>
                <p className="text-xs text-muted-foreground font-mono">
                  {shortenAddress(acc.publicKey)}
                </p>
                {vaultConfigs[acc.publicKey] && (
                  <p className="text-[10px] text-muted-foreground">
                    {vaultConfigs[acc.publicKey].threshold}-of-{vaultConfigs[acc.publicKey].totalParticipants} threshold
                  </p>
                )}
              </div>
              {acc.publicKey === activeAccount?.publicKey ? (
                <Badge variant="outline" className="text-[10px]">Active</Badge>
              ) : (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => switchVault(acc.publicKey)}
                  >
                    Switch
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-destructive hover:text-destructive"
                    onClick={() => {
                      if (accounts.length > 1) removeAccount(acc.publicKey);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div className="px-4 py-2">
            <Button
              variant="outline"
              className="w-full text-xs"
              onClick={() => onNavigate("vault-config")}
            >
              + Create new vault
            </Button>
          </div>
        </Card>
      )}

      <p className="text-[10px] text-muted-foreground text-center mt-auto">
        Vaulkyrie — Threshold security for Solana
      </p>
    </div>
  );
}
