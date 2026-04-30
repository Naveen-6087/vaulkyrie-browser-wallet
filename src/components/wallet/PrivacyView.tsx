import { useEffect, useMemo, useState } from "react";
import { Check, Copy, EyeOff, LockKeyhole, QrCode, RefreshCw, Shield, WalletCards } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { ScreenShell } from "@/components/layout/ScreenShell";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useWalletStore } from "@/store/walletStore";
import type { UmbraAccountRecord, UmbraActivityRecord, WalletView } from "@/types";
import {
  createUmbraWalletClient,
  formatAtomicAmount,
  parseUiAmount,
} from "@/services/umbra/umbraClient";
import { getUmbraTokens, toUmbraNetwork, type UmbraTokenConfig } from "@/services/umbra/umbraConfig";

interface PrivacyViewProps {
  onNavigate: (view: WalletView) => void;
}

export function PrivacyView({ onNavigate }: PrivacyViewProps) {
  const {
    activeAccount,
    network,
    getUmbraAccount,
    getUmbraActivities,
    upsertUmbraAccount,
    recordUmbraActivity,
    refreshAll,
  } = useWalletStore();
  const { copy, isCopied } = useCopyToClipboard({ resetAfterMs: 2000 });
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const tokenOptions = useMemo(() => {
    try {
      return getUmbraTokens(network);
    } catch {
      return [];
    }
  }, [network]);
  const [selectedMint, setSelectedMint] = useState(tokenOptions[0]?.mint ?? "");
  const selectedToken = tokenOptions.find((token) => token.mint === selectedMint) ?? tokenOptions[0];
  const owner = activeAccount?.publicKey ?? "";
  const umbraNetwork = useMemo(() => {
    try {
      return toUmbraNetwork(network);
    } catch {
      return null;
    }
  }, [network]);
  const record = owner && umbraNetwork ? getUmbraAccount(owner, umbraNetwork) : null;
  const activities = owner ? getUmbraActivities(owner).filter((activity) => activity.network === umbraNetwork) : [];
  const balance = selectedToken ? record?.balances[selectedToken.mint] : null;
  const isUnsupportedNetwork = umbraNetwork === null;

  useEffect(() => {
    if (tokenOptions.length === 0) {
      setSelectedMint("");
      return;
    }
    if (!tokenOptions.some((token) => token.mint === selectedMint)) {
      setSelectedMint(tokenOptions[0].mint);
    }
  }, [selectedMint, tokenOptions]);

  const runAction = async (label: string, action: () => Promise<void>) => {
    setIsBusy(true);
    setError(null);
    setStatus(label);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Privacy operation failed.");
    } finally {
      setIsBusy(false);
      setStatus(null);
    }
  };

  const persistAccount = (partial: Partial<UmbraAccountRecord>) => {
    if (!owner || !umbraNetwork) return;
    const now = Date.now();
    upsertUmbraAccount(owner, umbraNetwork, {
      ownerPublicKey: owner,
      network: umbraNetwork,
      registeredConfidential: false,
      registeredAnonymous: false,
      balances: {},
      ...record,
      ...partial,
      lastUpdatedAt: now,
    });
  };

  const recordActivity = (activity: Omit<UmbraActivityRecord, "id" | "ownerPublicKey" | "network" | "createdAt" | "updatedAt">) => {
    if (!owner || !umbraNetwork) return;
    const now = Date.now();
    recordUmbraActivity(owner, {
      id: `${activity.kind}-${now}`,
      ownerPublicKey: owner,
      network: umbraNetwork,
      createdAt: now,
      updatedAt: now,
      ...activity,
    });
  };

  const handleRegister = () => runAction("Registering encrypted account...", async () => {
    if (!owner || !umbraNetwork) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    const client = await createUmbraWalletClient(owner, network);
    const signatures = await client.registerConfidential();
    persistAccount({
      registeredConfidential: true,
      registeredAnonymous: false,
      masterSeedCreatedAt: record?.masterSeedCreatedAt ?? Date.now(),
    });
    recordActivity({
      kind: "register",
      status: "confirmed",
      queueSignature: signatures[0],
      callbackSignature: signatures[1],
    });
  });

  const handleRefresh = () => runAction("Decrypting encrypted balances...", async () => {
    if (!owner || !umbraNetwork) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    const client = await createUmbraWalletClient(owner, network);
    const balances = await client.queryBalances(tokenOptions);
    persistAccount({
      balances: balances.reduce<Record<string, typeof balances[number]>>((next, item) => {
        next[item.mint] = item;
        return next;
      }, {}),
    });
    recordActivity({ kind: "query", status: "confirmed" });
  });

  const handleDeposit = () => runAction("Shielding public balance...", async () => {
    ensureToken(selectedToken);
    if (!owner || !umbraNetwork) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    const amountAtomic = parseUiAmount(amount, selectedToken.decimals);
    const client = await createUmbraWalletClient(owner, network);
    const result = await client.deposit({
      destinationAddress: owner,
      mint: selectedToken.mint,
      amountAtomic,
    });
    recordActivity({
      kind: "deposit",
      status: result.callbackStatus === "timed-out" || result.callbackStatus === "pruned" ? "pending" : "confirmed",
      mint: selectedToken.mint,
      symbol: selectedToken.symbol,
      amountAtomic: amountAtomic.toString(),
      amountUi: formatAtomicAmount(amountAtomic, selectedToken.decimals),
      queueSignature: result.queueSignature,
      callbackSignature: result.callbackSignature,
      callbackStatus: result.callbackStatus,
      rentClaimSignature: result.rentClaimSignature,
    });
    setAmount("");
    await handlePostMutationRefresh(client, selectedToken);
  });

  const handleWithdraw = () => runAction("Unshielding encrypted balance...", async () => {
    ensureToken(selectedToken);
    if (!owner || !umbraNetwork) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    const amountAtomic = parseUiAmount(amount, selectedToken.decimals);
    const client = await createUmbraWalletClient(owner, network);
    const result = await client.withdraw({
      destinationAddress: destination.trim() || owner,
      mint: selectedToken.mint,
      amountAtomic,
    });
    recordActivity({
      kind: "withdraw",
      status: result.callbackStatus === "timed-out" || result.callbackStatus === "pruned" ? "pending" : "confirmed",
      mint: selectedToken.mint,
      symbol: selectedToken.symbol,
      amountAtomic: amountAtomic.toString(),
      amountUi: formatAtomicAmount(amountAtomic, selectedToken.decimals),
      queueSignature: result.queueSignature,
      callbackSignature: result.callbackSignature,
      callbackStatus: result.callbackStatus,
      rentClaimSignature: result.rentClaimSignature,
    });
    setAmount("");
    setDestination("");
    await handlePostMutationRefresh(client, selectedToken);
    void refreshAll();
  });

  const handlePostMutationRefresh = async (
    client: Awaited<ReturnType<typeof createUmbraWalletClient>>,
    token: UmbraTokenConfig,
  ) => {
    const [updated] = await client.queryBalances([token]);
    persistAccount({
      balances: {
        ...(record?.balances ?? {}),
        [token.mint]: updated,
      },
    });
  };

  const receiveUri = owner ? `solana:${owner}?label=Vaulkyrie%20Umbra` : "no-address";

  return (
    <ScreenShell
      title="Privacy"
      description="Shield supported SPL balances with Umbra encrypted accounts."
      onBack={() => onNavigate("dashboard")}
      backLabel="Back to dashboard"
      actions={(
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isBusy || isUnsupportedNetwork}>
          <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      )}
    >
      <div className="space-y-4">
        {isUnsupportedNetwork && (
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            Umbra privacy mode is available on Devnet and Mainnet. Switch networks to use shielded balances.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {status && (
          <div className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs text-primary">
            {status}
          </div>
        )}

        <Card className="p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              <Shield className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Encrypted account</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {record?.registeredConfidential
                  ? "Confidential mode is registered for this vault."
                  : "Register once before shielding supported tokens."}
              </p>
            </div>
            <span className={`rounded-md px-2 py-1 text-[10px] font-semibold ${
              record?.registeredConfidential ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
            }`}>
              {record?.registeredConfidential ? "Ready" : "Setup"}
            </span>
          </div>
          <Button className="mt-4 w-full" onClick={handleRegister} disabled={isBusy || isUnsupportedNetwork || !owner}>
            <LockKeyhole className="h-4 w-4" />
            Register encrypted account
          </Button>
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Shielded balance</p>
              <p className="text-xs text-muted-foreground">Shared encryption mode can be decrypted locally.</p>
            </div>
            <EyeOff className="h-4 w-4 text-muted-foreground" />
          </div>
          <SelectField
            value={selectedToken?.mint ?? selectedMint}
            onChange={(event) => setSelectedMint(event.target.value)}
            disabled={tokenOptions.length === 0}
          >
            {tokenOptions.map((token) => (
              <option key={token.mint} value={token.mint}>
                {token.symbol} - {token.name}
              </option>
            ))}
          </SelectField>
          <div className="mt-3 rounded-lg border border-border/70 bg-background/70 px-3 py-3">
            <p className="text-[11px] uppercase text-muted-foreground">Encrypted balance</p>
            <p className="mt-1 text-2xl font-semibold">
              {balance?.state === "shared" ? balance.balanceUi : "0"} {selectedToken?.symbol ?? ""}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              State: {balance?.state ?? "unknown"}
            </p>
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <WalletCards className="h-4 w-4 text-primary" />
            <p className="text-sm font-semibold">Move funds</p>
          </div>
          <div className="space-y-3">
            <Input
              inputMode="decimal"
              placeholder="Amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Input
              placeholder="Withdraw destination, defaults to this vault"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
            />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={handleDeposit} disabled={isBusy || isUnsupportedNetwork || !selectedToken}>
                Shield
              </Button>
              <Button onClick={handleWithdraw} disabled={isBusy || isUnsupportedNetwork || !selectedToken}>
                Unshield
              </Button>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <QrCode className="h-4 w-4 text-primary" />
            <p className="text-sm font-semibold">Private receive card</p>
          </div>
          <div className="flex flex-col items-center rounded-lg border border-border/70 bg-background/70 p-4 text-center">
            <div className="rounded-xl bg-white p-3">
              <QRCodeSVG value={receiveUri} size={132} bgColor="#ffffff" fgColor="#0a0a0a" level="M" />
            </div>
            <p className="mt-3 break-all text-xs font-mono text-muted-foreground">{owner || "No active wallet"}</p>
            <Button
              className="mt-3 w-full"
              variant={isCopied("umbra-receive") ? "secondary" : "outline"}
              onClick={() => copy(owner, "umbra-receive")}
              disabled={!owner}
            >
              {isCopied("umbra-receive") ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {isCopied("umbra-receive") ? "Copied" : "Copy receive address"}
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <p className="text-sm font-semibold">Recent privacy activity</p>
          <div className="mt-3 space-y-2">
            {activities.length === 0 ? (
              <p className="text-xs text-muted-foreground">No privacy activity yet.</p>
            ) : (
              activities.slice(0, 5).map((activity) => (
                <div key={activity.id} className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium capitalize">{activity.kind}</p>
                    <span className="text-[10px] text-muted-foreground">{activity.status}</span>
                  </div>
                  {activity.amountUi && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {activity.amountUi} {activity.symbol}
                    </p>
                  )}
                  {activity.queueSignature && (
                    <p className="mt-1 truncate text-[10px] font-mono text-muted-foreground">
                      {activity.queueSignature}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </ScreenShell>
  );
}

function ensureToken(token: UmbraTokenConfig | undefined): asserts token is UmbraTokenConfig {
  if (!token) {
    throw new Error("Select a supported Umbra token first.");
  }
}
