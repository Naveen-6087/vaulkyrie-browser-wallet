import { Bell, ChevronRight, Globe, Info, LifeBuoy, Lock, Shield, Trash2, Users, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScreenShell } from "@/components/layout/ScreenShell";
import { NETWORKS } from "@/lib/constants";
import { exportEncryptedWalletBackup } from "@/lib/walletBackup";
import { cn, shortenAddress } from "@/lib/utils";
import { useWalletStore } from "@/store/walletStore";
import type { NetworkId, WalletView } from "@/types";
import {
  DEFAULT_RELAY_URL,
  getRelayDisplayLabel,
  isManagedRelayUrl,
  probeRelayAvailability,
  validateRelayUrl,
} from "@/services/relay/relayAdapter";
import {
  listApprovedOrigins,
  revokeOrigin,
  type ApprovedOriginRecord,
} from "@/extension/approvalStorage";

interface SettingsViewProps {
  network: NetworkId;
  onNavigate: (view: WalletView) => void;
}

type SettingsSection = "overview" | "security" | "connections" | "recovery";

interface SettingRowProps {
  icon: typeof Shield;
  label: string;
  value?: string;
  badge?: string;
  onClick?: () => void;
}

interface SectionButtonProps {
  icon: typeof Shield;
  label: string;
  detail: string;
  isActive: boolean;
  onClick: () => void;
}

function SectionButton({ icon: Icon, label, detail, isActive, onClick }: SectionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-2xl border px-3 py-3 text-left transition-[border-color,background-color,color,transform] duration-200 cursor-pointer",
        isActive
          ? "border-primary/35 bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_rgba(78,205,196,0.12)]"
          : "border-border/80 bg-card/55 text-muted-foreground hover:border-primary/20 hover:bg-accent/45 hover:text-foreground",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-2xl",
            isActive ? "bg-primary/16 text-primary" : "bg-muted/80 text-muted-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{label}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
        </div>
      </div>
    </button>
  );
}

function SettingRow({ icon: Icon, label, value, badge, onClick }: SettingRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-accent/45 cursor-pointer"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/80 shrink-0">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        {value && <p className="mt-1 text-xs text-muted-foreground">{value}</p>}
      </div>
      {badge && <Badge variant="outline">{badge}</Badge>}
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}

function SummaryTile({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "primary" }) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-3 py-3",
        tone === "primary" ? "border-primary/25 bg-primary/8" : "border-border/80 bg-card/55",
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-sm font-semibold">{value}</p>
    </div>
  );
}

export function SettingsView({ network, onNavigate }: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("overview");
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
  const [currentTime, setCurrentTime] = useState(() => Date.now());
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
  const activeCooldown = unlockBlockedUntil !== null && unlockBlockedUntil > currentTime;
  const usingManagedRelay = isManagedRelayUrl(relayUrl);
  const relayDisplayLabel = getRelayDisplayLabel(relayUrl);

  useEffect(() => {
    if (!activeCooldown) return;
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [activeCooldown]);

  useEffect(() => {
    setRelayDraft(relayUrl);
  }, [relayUrl]);

  useEffect(() => {
    if (activeSection !== "connections") return;

    let cancelled = false;
    setSitesLoading(true);
    setSitesError("");

    void listApprovedOrigins(activeAccount?.publicKey ?? null)
      .then((records) => {
        if (!cancelled) {
          setApprovedOrigins(records);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSitesError(error instanceof Error ? error.message : "Failed to load connected sites.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSitesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeAccount?.publicKey, activeSection]);

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
      if (!cancelled) {
        setRelayStatus(available ? "reachable" : "unreachable");
        setRelayError(available ? "" : "Relay unreachable from this browser right now.");
      }
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

      setBackupStatus("Encrypted backup downloaded. Restore it from onboarding on another device.");
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

  const sectionButtons: Array<{
    id: SettingsSection;
    icon: typeof Shield;
    label: string;
    detail: string;
  }> = [
    {
      id: "overview",
      icon: Wallet,
      label: "Overview",
      detail: `${accounts.length} vault${accounts.length === 1 ? "" : "s"} · ${NETWORKS[network].name}`,
    },
    {
      id: "security",
      icon: Shield,
      label: "Security",
      detail: `${securityPreferences.autoLockMinutes}m auto-lock · ${securityPreferences.lockOnHide ? "lock on hide" : "background allowed"}`,
    },
    {
      id: "connections",
      icon: Globe,
      label: "Connections",
      detail: `${approvedOrigins.length} approved site${approvedOrigins.length === 1 ? "" : "s"} · ${relayStatus}`,
    },
    {
      id: "recovery",
      icon: LifeBuoy,
      label: "Recovery",
      detail: "Encrypted backups and restore workflow",
    },
  ];

  return (
    <ScreenShell
      title="Settings"
      description="Manage vault security, site connections, recovery, and relay behavior."
      onBack={() => onNavigate("dashboard")}
      backLabel="Back to dashboard"
    >
      <div className="space-y-4">
        <Card className="p-2">
          <div className="grid grid-cols-2 gap-2">
            {sectionButtons.map((section) => (
              <SectionButton
                key={section.id}
                icon={section.icon}
                label={section.label}
                detail={section.detail}
                isActive={activeSection === section.id}
                onClick={() => setActiveSection(section.id)}
              />
            ))}
          </div>
        </Card>

        {activeSection === "overview" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <SummaryTile label="Network" value={NETWORKS[network].name} tone="primary" />
              <SummaryTile
                label="Vaults"
                value={`${accounts.length} configured`}
              />
              <SummaryTile
                label="Relay"
                value={usingManagedRelay ? "Managed relay" : "Self-hosted"}
              />
              <SummaryTile
                label="Session"
                value={passwordHash ? "Password locked" : "Password setup pending"}
              />
            </div>

            <Card className="overflow-hidden">
              <div className="border-b border-border/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Wallet navigation
                </p>
              </div>
              <div className="p-1">
                <SettingRow
                  icon={Shield}
                  label="Privacy"
                  value="Shielded accounts and private swap tools"
                  onClick={() => onNavigate("privacy")}
                />
                <SettingRow
                  icon={LifeBuoy}
                  label="Recovery & Restore"
                  value="Open recovery coordination and import/export tools"
                  onClick={() => onNavigate("recovery")}
                />
                <SettingRow
                  icon={Users}
                  label="Address Book"
                  value="Saved recipients for faster transfers"
                  onClick={() => onNavigate("contacts")}
                />
                <SettingRow
                  icon={Bell}
                  label="DApp Approvals"
                  value="Review extension connection and signature prompts"
                  onClick={() => onNavigate("approval")}
                />
                <SettingRow
                  icon={Info}
                  label="About Vaulkyrie"
                  value="v0.1.0 · Solana threshold wallet"
                />
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-border/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Your vaults
                </p>
              </div>
              <div className="space-y-2 p-4">
                {accounts.map((acc) => (
                  <div
                    key={acc.publicKey}
                    className="flex items-center gap-3 rounded-2xl border border-border/80 bg-card/55 px-3 py-3"
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/12">
                      <Wallet className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {vaultConfigs[acc.publicKey]?.vaultName ?? acc.name}
                      </p>
                      <p className="mt-1 text-xs font-mono text-muted-foreground">
                        {shortenAddress(acc.publicKey, 6)}
                      </p>
                      {vaultConfigs[acc.publicKey] && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {vaultConfigs[acc.publicKey].threshold}-of-{vaultConfigs[acc.publicKey].totalParticipants} threshold
                        </p>
                      )}
                    </div>
                    {acc.publicKey === activeAccount?.publicKey ? (
                      <Badge variant="outline" className="text-[10px]">Active</Badge>
                    ) : (
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => switchVault(acc.publicKey)}>
                          Switch
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            if (accounts.length > 1) removeAccount(acc.publicKey);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
                <Button variant="outline" className="w-full" onClick={() => onNavigate("vault-config")}>
                  Create new vault
                </Button>
              </div>
            </Card>
          </>
        )}

        {activeSection === "security" && (
          <>
            <Card className="overflow-hidden">
              <div className="border-b border-border/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
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

                <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/80 bg-card/55 px-3 py-3">
                  <div>
                    <p className="text-sm font-medium">Lock when hidden</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Automatically locks the wallet when the popup loses visibility.
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

                <div className="rounded-2xl border border-border/80 bg-card/55 px-3 py-3">
                  <p className="text-sm font-medium">Unlock backoff</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    After repeated failed unlock attempts, Vaulkyrie adds a cooldown before the next try.
                  </p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Status: {activeCooldown ? "Cooldown active" : "No active cooldown"}
                  </p>
                </div>

                <Button
                  className="w-full"
                  onClick={() => {
                    setLocked(true);
                    onNavigate("lock");
                  }}
                >
                  <Lock className="h-4 w-4" />
                  Lock wallet now
                </Button>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-border/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Approval controls
                </p>
              </div>
              <div className="space-y-3 p-4">
                <p className="text-sm font-medium">Extension request review</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Vaulkyrie scopes site connections per vault and still asks before each signature.
                </p>
                <Button variant="outline" className="w-full" onClick={() => onNavigate("approval")}>
                  Open DApp approvals
                </Button>
              </div>
            </Card>
          </>
        )}

        {activeSection === "connections" && (
          <>
            <Card className="overflow-hidden">
              <div className="border-b border-border/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Connected sites
                </p>
              </div>
              <div className="space-y-3 p-4">
                <p className="text-xs text-muted-foreground">
                  Review which websites can connect to this Vaulkyrie extension wallet and revoke access per origin.
                </p>

                {sitesError && <p className="text-xs text-destructive">{sitesError}</p>}

                {sitesLoading ? (
                  <div className="rounded-2xl border border-border/80 bg-card/55 px-3 py-4 text-xs text-muted-foreground">
                    Loading approved origins…
                  </div>
                ) : approvedOrigins.length === 0 ? (
                  <div className="rounded-2xl border border-border/80 bg-card/55 px-3 py-4 text-xs text-muted-foreground">
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
                          className="rounded-2xl border border-border/80 bg-card/55 px-3 py-3"
                        >
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10">
                              <Globe className="h-4 w-4 text-primary" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="break-all text-sm font-medium">{site.origin}</p>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                Approved: {formatSiteTimestamp(site.approvedAt)}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                Last used: {formatSiteTimestamp(site.lastUsedAt)}
                              </p>
                              <p className="mt-1 text-[11px] font-mono text-muted-foreground">
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

            <Card className="overflow-hidden">
              <div className="border-b border-border/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Cross-device relay
                </p>
              </div>
              <div className="space-y-3 p-4">
                <p className="text-xs text-muted-foreground">
                  Most users should keep the managed relay. Self-hosted endpoints are only needed for advanced deployments.
                </p>
                <div className="flex items-center justify-between rounded-2xl border border-border/80 bg-card/55 px-3 py-2.5 text-xs">
                  <span className="text-muted-foreground">Relay source</span>
                  <span className="text-foreground">
                    {usingManagedRelay ? "Managed by Vaulkyrie" : "Self-hosted override"}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-border/80 bg-card/55 px-3 py-2.5 text-xs">
                  <span className="text-muted-foreground">Relay health</span>
                  <span
                    className={
                      relayStatus === "reachable"
                        ? "text-emerald-400"
                        : relayStatus === "checking"
                          ? "text-amber-400"
                          : "text-destructive"
                    }
                  >
                    {relayStatus === "reachable"
                      ? "Reachable"
                      : relayStatus === "checking"
                        ? "Checking…"
                        : "Unavailable"}
                  </span>
                </div>
                <div className="rounded-2xl border border-border/80 bg-card/55 px-3 py-2.5 text-xs text-muted-foreground">
                  Active endpoint: <span className="font-mono text-foreground">{relayDisplayLabel}</span>
                </div>
                <Input
                  value={relayDraft}
                  onChange={(event) => setRelayDraft(event.target.value)}
                  placeholder={DEFAULT_RELAY_URL}
                />
                {relayError && <p className="text-xs text-destructive">{relayError}</p>}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                    Use self-hosted relay
                  </Button>
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={() => {
                      setRelayError("");
                      setRelayDraft(DEFAULT_RELAY_URL);
                      setRelayUrl(DEFAULT_RELAY_URL);
                    }}
                  >
                    Use Vaulkyrie relay
                  </Button>
                </div>
              </div>
            </Card>
          </>
        )}

        {activeSection === "recovery" && (
          <>
            <Card className="overflow-hidden">
              <div className="border-b border-border/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Backup export
                </p>
              </div>
              <div className="space-y-3 p-4">
                <p className="text-xs text-muted-foreground">
                  Download an encrypted local backup of this browser wallet. Restore previews and onchain recovery coordination live in the dedicated recovery screen.
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
                {backupError && <p className="text-xs text-destructive">{backupError}</p>}
                {backupStatus && <p className="text-xs text-emerald-400">{backupStatus}</p>}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleExportBackup}
                  disabled={isExportingBackup}
                >
                  {isExportingBackup ? "Exporting encrypted backup…" : "Download encrypted backup"}
                </Button>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-border/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Recovery tools
                </p>
              </div>
              <div className="space-y-3 p-4">
                <p className="text-sm font-medium">Recovery & restore workspace</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Open the full recovery view for encrypted backup imports, staged restore previews, and onchain recovery coordination.
                </p>
                <Button className="w-full" onClick={() => onNavigate("recovery")}>
                  Open Recovery & Restore
                </Button>
              </div>
            </Card>
          </>
        )}

        <p className="pt-1 text-center text-[10px] text-muted-foreground">
          Vaulkyrie — Threshold security for Solana
        </p>
      </div>
    </ScreenShell>
  );
}
