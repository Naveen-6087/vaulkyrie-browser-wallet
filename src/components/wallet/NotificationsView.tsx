import { useMemo, useState } from "react";
import {
  Bell,
  Check,
  Copy,
  ExternalLink,
  Inbox,
  Radio,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScreenShell } from "@/components/layout/ScreenShell";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { NETWORKS } from "@/lib/constants";
import { cn, shortenAddress } from "@/lib/utils";
import { parseSessionInvite } from "@/services/relay/sessionInvite";
import { useWalletStore } from "@/store/walletStore";
import type { NetworkId, WalletView } from "@/types";

interface NotificationsViewProps {
  onNavigate: (view: WalletView) => void;
  onJoinInvite: (invite: string) => void;
}

function explorerTxUrl(signature: string, network: NetworkId) {
  const cluster = network === "mainnet" ? "" : `?cluster=${network}`;
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

export function NotificationsView({ onNavigate, onJoinInvite }: NotificationsViewProps) {
  const [invite, setInvite] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [browserAlertState, setBrowserAlertState] = useState<NotificationPermission>(() =>
    typeof Notification === "undefined" ? "denied" : Notification.permission,
  );
  const {
    activeAccount,
    network,
    signingNotifications,
    vaultConfigs,
    getDkgResult,
    getOrchestrationHistory,
    markSigningNotificationRead,
    clearSigningNotifications,
  } = useWalletStore();
  const { copy, isCopied } = useCopyToClipboard({ resetAfterMs: 1500 });

  const activeDkg = activeAccount ? getDkgResult(activeAccount.publicKey) : null;
  const thresholdLabel = activeDkg
    ? `${activeDkg.threshold}-of-${activeDkg.participants}`
    : activeAccount && vaultConfigs[activeAccount.publicKey]
      ? `${vaultConfigs[activeAccount.publicKey].threshold}-of-${vaultConfigs[activeAccount.publicKey].totalParticipants}`
      : "Not configured";
  const accountNotifications = signingNotifications.filter(
    (notification) =>
      !notification.accountPublicKey || notification.accountPublicKey === activeAccount?.publicKey,
  );
  const unreadCount = accountNotifications.filter((notification) => !notification.read).length;
  const recentActivity = activeAccount ? getOrchestrationHistory(activeAccount.publicKey).slice(0, 4) : [];

  const parsedInvite = useMemo(() => parseSessionInvite(invite), [invite]);

  const handleJoin = () => {
    if (!parsedInvite) {
      setInviteError("Paste the full invite from the coordinator.");
      return;
    }

    setInviteError("");
    onJoinInvite(parsedInvite.invite);
  };

  const handleBrowserAlerts = async () => {
    if (!("Notification" in window)) {
      setBrowserAlertState("denied");
      return;
    }

    const permission = await Notification.requestPermission();
    setBrowserAlertState(permission);
  };

  return (
    <ScreenShell
      title="Signing Inbox"
      description="Join ceremonies, approve signing requests, and review recent coordinated sends."
      onBack={() => onNavigate("dashboard")}
      backLabel="Back to dashboard"
    >
      <div className="space-y-4">
        <Card className="overflow-hidden">
          <div className="border-b border-border/70 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">Multi-device signing</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Paste an invite here from any Vaulkyrie signing flow.
                </p>
              </div>
              <Badge variant={unreadCount > 0 ? "default" : "outline"}>
                {unreadCount > 0 ? `${unreadCount} new` : "Clear"}
              </Badge>
            </div>
          </div>
          <div className="space-y-3 p-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-border/80 bg-card/55 px-3 py-3">
                <p className="text-[11px] text-muted-foreground">Vault</p>
                <p className="mt-1 truncate text-sm font-semibold">
                  {activeAccount?.name ?? "No active vault"}
                </p>
              </div>
              <div className="rounded-xl border border-border/80 bg-card/55 px-3 py-3">
                <p className="text-[11px] text-muted-foreground">Policy</p>
                <p className="mt-1 text-sm font-semibold">{thresholdLabel}</p>
              </div>
            </div>

            <div className="space-y-2">
              <Input
                value={invite}
                onChange={(event) => {
                  setInvite(event.target.value);
                  setInviteError("");
                }}
                placeholder="Paste signing invite"
                className="font-mono text-xs"
                maxLength={512}
              />
              {parsedInvite && (
                <div className="rounded-xl border border-primary/25 bg-primary/5 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-primary">Verify</p>
                  <p className="mt-1 font-mono text-sm font-semibold">
                    {parsedInvite.verificationPhrase}
                  </p>
                </div>
              )}
              {inviteError && <p className="text-xs text-destructive">{inviteError}</p>}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button className="w-full gap-2" onClick={handleJoin}>
                <Radio className="h-4 w-4" />
                Join signing
              </Button>
              <Button variant="outline" className="w-full gap-2" onClick={() => onNavigate("join-ceremony")}>
                <Users className="h-4 w-4" />
                Join wallet setup
              </Button>
            </div>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-border/70 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Alerts
            </p>
          </div>
          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-card/55 px-3 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/12">
                  <Bell className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">Browser alerts</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {browserAlertState === "granted"
                      ? "Enabled for this device."
                      : "Enable alerts for local signing requests."}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant={browserAlertState === "granted" ? "secondary" : "outline"}
                onClick={handleBrowserAlerts}
                disabled={browserAlertState === "granted"}
              >
                {browserAlertState === "granted" ? "On" : "Enable"}
              </Button>
            </div>

            {accountNotifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/80 bg-card/45 px-4 py-8 text-center">
                <Inbox className="h-8 w-8 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">No signing alerts</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    New invites and approval requests will appear here.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {accountNotifications.slice(0, 8).map((notification) => (
                  <div
                    key={notification.id}
                    className={cn(
                      "rounded-xl border px-3 py-3",
                      notification.read
                        ? "border-border/80 bg-card/45"
                        : "border-primary/25 bg-primary/5",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/12">
                        <ShieldCheck className="h-4 w-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium">{notification.title}</p>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {formatTime(notification.createdAt)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {notification.detail}
                        </p>
                        {notification.verificationPhrase && (
                          <p className="mt-2 font-mono text-[11px] text-foreground">
                            {notification.verificationPhrase}
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {notification.invite && (
                            <>
                              <Button
                                size="sm"
                                className="gap-2"
                                onClick={() => {
                                  markSigningNotificationRead(notification.id);
                                  onJoinInvite(notification.invite ?? "");
                                }}
                              >
                                <Radio className="h-3.5 w-3.5" />
                                Join
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-2"
                                onClick={() => copy(notification.invite ?? "", notification.id)}
                              >
                                {isCopied(notification.id) ? (
                                  <Check className="h-3.5 w-3.5 text-success" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                                Copy
                              </Button>
                            </>
                          )}
                          {!notification.read && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => markSigningNotificationRead(notification.id)}
                            >
                              Mark read
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                <Button variant="ghost" className="w-full gap-2" onClick={clearSigningNotifications}>
                  <Trash2 className="h-4 w-4" />
                  Clear alerts
                </Button>
              </div>
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-border/70 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Recent coordinated sends
            </p>
          </div>
          <div className="space-y-2 p-4">
            {recentActivity.length === 0 ? (
              <div className="rounded-xl border border-border/80 bg-card/45 px-3 py-4 text-xs text-muted-foreground">
                No multi-device sends yet.
              </div>
            ) : (
              recentActivity.map((activity) => (
                <div
                  key={activity.id}
                  className="rounded-xl border border-border/80 bg-card/45 px-3 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {activity.amount} {activity.token}
                      </p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        To {shortenAddress(activity.recipient, 6)}
                      </p>
                    </div>
                    <a
                      href={explorerTxUrl(activity.signature, activity.network)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/80 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      aria-label="View transaction on explorer"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <p className="text-center text-[10px] text-muted-foreground">
          Active network: {NETWORKS[network].name}
        </p>
      </div>
    </ScreenShell>
  );
}
