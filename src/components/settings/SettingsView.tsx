import { Shield, ChevronRight, Globe, Key, Bell, Info, Wallet, Trash2, Users, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWalletStore } from "@/store/walletStore";
import { shortenAddress } from "@/lib/utils";
import type { NetworkId, WalletView } from "@/types";
import { NETWORKS } from "@/lib/constants";
import { probeRelayAvailability, validateRelayUrl } from "@/services/relay/relayAdapter";
import { exportEncryptedWalletBackup } from "@/lib/walletBackup";
import {
  listApprovedOrigins,
  revokeOrigin,
  type ApprovedOriginRecord,
} from "@/extension/approvalStorage";

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
  const [showConnectedSites, setShowConnectedSites] = useState(false);
  const [relayDraft, setRelayDraft] = useState("");
  const [relayStatus, setRelayStatus] = useState<"checking" | "reachable" | "unreachable">("checking");
  const [relayError, setRelayError] = useState("");
  const [backupPassword, setBackupPassword] = useState("");
  const [backupConfirm, setBackupConfirm] = useState("");
  const [backupStatus, setBackupStatus] = useState("");
  const [backupError, setBackupError] = useState("");
  const [isExportingBackup, setIsExportingBackup] = useState(false);
  const [approvedOrigins, setApprovedOrigins] = useState<ApprovedOriginRecord[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [sitesError, setSitesError] = useState("");
  const [revokingSiteKey, setRevokingSiteKey] = useState<string | null>(null);
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
    if (!showConnectedSites) return;

    let cancelled = false;
    setSitesLoading(true);
    setSitesError("");

    void listApprovedOrigins(activeAccount?.publicKey ?? null)
      .then((records) => {
        if (cancelled) return;
        setApprovedOrigins(records);
      })
      .catch((error) => {
        if (cancelled) return;
        setSitesError(error instanceof Error ? error.message : "Failed to load connected sites.");
      })
      .finally(() => {
        if (!cancelled) {
          setSitesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeAccount?.publicKey, showConnectedSites]);

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

  const handleExportBackup = async () => {
    if (accounts.length === 0) {
      setBackupError("Create or restore a vault before exporting a backup.");
      return;
    }
    if (backupPassword.length < 10) {
      setBackupError("Backup password must be at least 10 characters.");
      return;
    }
    if (backupPassword !== backupConfirm) {
      setBackupError("Backup passwords do not match.");
      return;
    }

    setIsExportingBackup(true);
    setBackupError("");
    setBackupStatus("");

    try {
      const backup = await exportEncryptedWalletBackup(backupPassword);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `vaulkyrie-backup-${new Date(backup.exportedAt).toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);

      setBackupStatus("Encrypted backup downloaded. Import it from the onboarding screen on another device.");
      setBackupPassword("");
      setBackupConfirm("");
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "Failed to export encrypted backup.");
    } finally {
      setIsExportingBackup(false);
    }
  };

  const handleRevokeSite = async (site: ApprovedOriginRecord) => {
    const siteKey = `${site.origin}:${site.accountPublicKey ?? "all"}`;
    setRevokingSiteKey(siteKey);
    setSitesError("");

    try {
      await revokeOrigin(site.origin, site.accountPublicKey);
      setApprovedOrigins((current) =>
        current.filter(
          (record) =>
            !(record.origin === site.origin && record.accountPublicKey === site.accountPublicKey),
        ),
      );
    } catch (error) {
      setSitesError(error instanceof Error ? error.message : "Failed to revoke the selected site.");
    } finally {
      setRevokingSiteKey(null);
    }
  };

  const formatSiteTimestamp = (value: number) => {
    if (!value) return "Unknown";
    return new Date(value).toLocaleString();
  };

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
          label="Connected Sites"
          value={activeAccount ? "Manage approved extension origins" : "Unlock a vault to view site access"}
          badge={`${approvedOrigins.length}`}
          onClick={() => setShowConnectedSites(!showConnectedSites)}
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

      {showConnectedSites && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Connected sites
            </p>
          </div>
          <div className="space-y-3 p-4">
            <p className="text-xs text-muted-foreground">
              Review which websites can connect to this Vaulkyrie extension wallet and revoke access per origin.
            </p>

            {sitesError && (
              <p className="text-xs text-red-400">{sitesError}</p>
            )}

            {sitesLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Bell className="h-3.5 w-3.5 animate-pulse" />
                Loading approved origins…
              </div>
            ) : approvedOrigins.length === 0 ? (
              <div className="rounded-xl border border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
                No connected sites have been approved for {activeAccount ? shortenAddress(activeAccount.publicKey) : "this wallet"} yet.
              </div>
            ) : (
              <div className="space-y-2">
                {approvedOrigins.map((site) => {
                  const siteKey = `${site.origin}:${site.accountPublicKey ?? "all"}`;
                  const isRevoking = revokingSiteKey === siteKey;

                  return (
                    <div
                      key={siteKey}
                      className="rounded-xl border border-border bg-card/60 px-3 py-3"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
                          <Globe className="h-4 w-4 text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium break-all">{site.origin}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Approved: {formatSiteTimestamp(site.approvedAt)}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Last used: {formatSiteTimestamp(site.lastUsedAt)}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground font-mono">
                            Account: {site.accountPublicKey ? shortenAddress(site.accountPublicKey) : "Any active vault"}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => void handleRevokeSite(site)}
                          disabled={isRevoking}
                        >
                          {isRevoking ? "Revoking..." : "Revoke"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Backup & restore
          </p>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-xs text-muted-foreground">
            Export an encrypted local backup of this browser wallet. You can restore it later from the onboarding screen using <span className="font-medium text-foreground">Import Existing Vault</span>.
          </p>
          <Input
            type="password"
            value={backupPassword}
            onChange={(event) => {
              setBackupPassword(event.target.value);
              setBackupError("");
            }}
            placeholder="Backup password"
          />
          <Input
            type="password"
            value={backupConfirm}
            onChange={(event) => {
              setBackupConfirm(event.target.value);
              setBackupError("");
            }}
            placeholder="Confirm backup password"
          />
          {backupError && <p className="text-xs text-red-400">{backupError}</p>}
          {backupStatus && <p className="text-xs text-emerald-400">{backupStatus}</p>}
          <Button
            variant="outline"
            className="w-full"
            onClick={handleExportBackup}
            disabled={isExportingBackup}
          >
            {isExportingBackup ? "Exporting encrypted backup…" : "Download encrypted backup"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Onchain recovery and authority-migration flows are still separate from this local restore path.
          </p>
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
