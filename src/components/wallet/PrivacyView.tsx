import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  EyeOff,
  Inbox,
  LockKeyhole,
  QrCode,
  RefreshCw,
  Repeat2,
  Send,
  Shield,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { ScreenShell } from "@/components/layout/ScreenShell";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { getWalletAccountKind } from "@/lib/walletAccounts";
import { cn, shortenAddress } from "@/lib/utils";
import { useWalletStore } from "@/store/walletStore";
import type { UmbraAccountRecord, UmbraActivityRecord, WalletView } from "@/types";
import {
  createUmbraWalletClient,
  formatAtomicAmount,
  parseUiAmount,
  type UmbraIncomingUtxos,
} from "@/services/umbra/umbraClient";
import { formatUmbraErrorMessage } from "@/services/umbra/umbraError";
import { getUmbraTokens, toUmbraNetwork, type UmbraTokenConfig } from "@/services/umbra/umbraConfig";
import { createConnection, requestSolAirdrop } from "@/services/solanaRpc";
import { unwrapAllSolForVault, wrapSolForVault } from "@/services/umbra/wrappedSol";

interface PrivacyViewProps {
  onNavigate: (view: WalletView) => void;
}

type PrivacySection =
  | "overview"
  | "balances"
  | "move"
  | "transfer"
  | "inbox"
  | "receive"
  | "activity";

interface SectionButtonProps {
  icon: LucideIcon;
  label: string;
  detail: string;
  isActive: boolean;
  badge?: string;
  onClick: () => void;
}

interface PrivacySectionItem {
  id: PrivacySection;
  icon: LucideIcon;
  label: string;
  detail: string;
}

const PRIVACY_SECTION_ITEMS: readonly PrivacySectionItem[] = [
  {
    id: "overview",
    icon: Shield,
    label: "Overview",
    detail: "See readiness, funding requirements, and the full privacy flow.",
  },
  {
    id: "balances",
    icon: EyeOff,
    label: "Balances",
    detail: "Inspect encrypted and public balances for the selected Umbra pool.",
  },
  {
    id: "move",
    icon: WalletCards,
    label: "Move funds",
    detail: "Shield public funds, unshield encrypted funds, and manage SOL or wSOL.",
  },
  {
    id: "transfer",
    icon: Send,
    label: "Private transfer",
    detail: "Send receiver-claimable private notes from shielded or public balance.",
  },
  {
    id: "inbox",
    icon: Inbox,
    label: "Inbox",
    detail: "Scan for incoming private notes and claim them back into encrypted balance.",
  },
  {
    id: "receive",
    icon: QrCode,
    label: "Receive",
    detail: "Share your current Privacy Vault address for Umbra transfers.",
  },
  {
    id: "activity",
    icon: RefreshCw,
    label: "Activity",
    detail: "Review the latest privacy actions, callbacks, and failures.",
  },
] as const;

function SectionButton({ icon: Icon, label, detail, isActive, badge, onClick }: SectionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={detail}
      className={cn(
        "w-full rounded-2xl border px-3 py-3 text-left transition-[border-color,background-color,color,box-shadow] duration-200 cursor-pointer",
        isActive
          ? "border-primary/40 bg-primary/12 text-foreground shadow-[inset_0_0_0_1px_rgba(78,205,196,0.14)]"
          : "border-border/80 bg-card/55 text-muted-foreground hover:border-primary/20 hover:bg-accent/45 hover:text-foreground",
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl",
            isActive ? "bg-primary/16 text-primary" : "bg-muted/80 text-muted-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{label}</p>
            {badge && (
              <Badge variant={isActive ? "success" : "outline"} className="px-1.5 py-0 text-[10px]">
                {badge}
              </Badge>
            )}
          </div>
        </div>
      </div>
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

function TokenAvatar({ token, className }: { token?: UmbraTokenConfig; className?: string }) {
  const [failed, setFailed] = useState(false);
  const symbol = token?.symbol ?? "??";
  const hue = symbol.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;

  if (token?.icon && !failed) {
    return (
      <img
        src={token.icon}
        alt={token.symbol}
        className={cn("h-10 w-10 rounded-full object-cover", className)}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className={cn("flex h-10 w-10 items-center justify-center rounded-full text-[11px] font-bold text-white", className)}
      style={{
        background: `linear-gradient(135deg, oklch(0.60 0.15 ${hue}), oklch(0.45 0.12 ${hue + 30}))`,
      }}
    >
      {symbol.slice(0, 2)}
    </div>
  );
}

const REGISTER_MIN_SOL = 0.02;
const DEVNET_AIRDROP_SOL = 1;

export function PrivacyView({ onNavigate }: PrivacyViewProps) {
  const {
    activeAccount,
    network,
    getUmbraAccount,
    getUmbraActivities,
    upsertUmbraAccount,
    recordUmbraActivity,
    refreshAll,
    tokens,
  } = useWalletStore();
  const { copy, isCopied } = useCopyToClipboard({ resetAfterMs: 2000 });
  const [activeSection, setActiveSection] = useState<PrivacySection>("overview");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [privateDestination, setPrivateDestination] = useState("");
  const [incomingUtxos, setIncomingUtxos] = useState<UmbraIncomingUtxos | null>(null);
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
  const activeAccountKind = getWalletAccountKind(activeAccount);
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
  const receivedUtxos = incomingUtxos ? [...incomingUtxos.received, ...incomingUtxos.publicReceived] : [];
  const inboxNoteCount = countClaimableIncomingNotes(incomingUtxos);
  const isUnsupportedNetwork = umbraNetwork === null;
  const isWrappedSol = selectedToken?.mint === "So11111111111111111111111111111111111111112";
  const nativeSolBalance = tokens.find((token) => token.symbol === "SOL" && !token.mint)?.balance ?? activeAccount?.balance ?? 0;
  const publicWrappedSolBalance = tokens.find((token) => token.mint === selectedToken?.mint)?.balance ?? 0;
  const publicTokenBalance = isWrappedSol
    ? publicWrappedSolBalance
    : tokens.find((token) => token.mint === selectedToken?.mint || token.symbol === selectedToken?.symbol)?.balance ?? 0;
  const registrationReady = Boolean(record?.registeredConfidential && record.registeredAnonymous);
  const needsRegistrationFunding = !registrationReady && nativeSolBalance < REGISTER_MIN_SOL;
  const balanceSummary =
    balance?.state === "shared"
      ? `${balance.balanceUi ?? "0"} ${selectedToken?.symbol ?? ""}`
      : balance?.state === "error"
        ? "Balance error"
      : balance?.state === "mxe"
        ? "MPC-only balance"
        : balance?.state === "uninitialized"
          ? "Initializing"
          : "No shielded balance";
  const wrappedSolSettlementNote = isWrappedSol && publicWrappedSolBalance === 0 && nativeSolBalance > 0
    ? "If native SOL increased while public wSOL stayed at 0, this withdrawal already landed as spendable SOL."
    : null;

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
    await waitForUiPaint();
    try {
      await action();
    } catch (caught) {
      setError(normalizePrivacyError(caught, { network, publicSolBalance: nativeSolBalance }));
    } finally {
      setIsBusy(false);
      setStatus(null);
    }
  };

  const persistAccount = (partial: Partial<UmbraAccountRecord>) => {
    if (!owner || !umbraNetwork) return;
    const now = Date.now();
    const currentRecord = getLatestUmbraAccountRecord(owner, umbraNetwork);
    upsertUmbraAccount(owner, umbraNetwork, {
      ownerPublicKey: owner,
      network: umbraNetwork,
      registeredConfidential: false,
      registeredAnonymous: false,
      balances: {},
      ...currentRecord,
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

  const syncAccountState = async (client: Awaited<ReturnType<typeof createUmbraWalletClient>>) => {
    const accountState = await client.queryAccountState(owner);
    const latestRecord = getLatestUmbraAccountRecord(owner, umbraNetwork);
    persistAccount({
      registeredConfidential: accountState.confidential,
      registeredAnonymous: accountState.anonymous,
      masterSeedCreatedAt: latestRecord?.masterSeedCreatedAt ?? (accountState.exists ? Date.now() : undefined),
    });
    return accountState;
  };

  const refreshIncomingNotes = async (
    client: Awaited<ReturnType<typeof createUmbraWalletClient>>,
    accountState: Awaited<ReturnType<typeof syncAccountState>>,
  ) => {
    if (!accountState.anonymous) {
      setIncomingUtxos(null);
      return 0;
    }

    const latestRecord = getLatestUmbraAccountRecord(owner, umbraNetwork);
    const claimedNoteKeys = new Set(latestRecord?.claimedInboxNoteKeys ?? []);
    const result = await client.scanIncomingUtxos(latestRecord?.nextInboxScanStartIndex);
    const filtered = filterClaimedIncomingNotes(result, claimedNoteKeys);
    setIncomingUtxos(filtered);
    const claimableCount = countClaimableIncomingNotes(filtered);
    if (claimableCount === 0 && result.nextScanStartIndex !== undefined) {
      persistAccount({ nextInboxScanStartIndex: result.nextScanStartIndex });
    }
    return claimableCount;
  };

  const handleRegister = () => runAction("Registering encrypted account...", async () => {
    if (!owner || !umbraNetwork) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    if (needsRegistrationFunding) {
      throw new Error(buildFundingError(umbraNetwork));
    }
    const client = await createUmbraWalletClient(owner, network);
    const accountState = await client.queryAccountState(owner);
    if (accountState.confidential && accountState.anonymous) {
      await syncAccountState(client);
      return;
    }
    const signatures = await client.registerConfidential();
    await syncAccountState(client);
    recordActivity({
      kind: "register",
      status: "confirmed",
      queueSignature: signatures[0],
      callbackSignature: signatures.length > 1 ? signatures[signatures.length - 1] : undefined,
    });
  });

  const handleDevnetAirdrop = () => runAction(`Requesting ${DEVNET_AIRDROP_SOL} devnet SOL...`, async () => {
    if (!owner) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    if (network !== "devnet") throw new Error("Airdrops are only available on devnet.");
    await requestSolAirdrop(network, owner, DEVNET_AIRDROP_SOL);
    await refreshAll();
  });

  const handleRefresh = () => runAction("Refreshing Umbra account state...", async () => {
    if (!owner || !umbraNetwork) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    const client = await createUmbraWalletClient(owner, network);
    const accountState = await syncAccountState(client);
    const balances = await client.queryBalances(tokenOptions);
    persistAccount({
      balances: balances.reduce<Record<string, typeof balances[number]>>((next, item) => {
        next[item.mint] = item;
        return next;
      }, {}),
    });
    setStatus("Scanning inbox for incoming private notes...");
    await waitForUiPaint();
    const utxoCount = await refreshIncomingNotes(client, accountState);
    recordActivity({ kind: "query", status: "confirmed", utxoCount });
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

  const handlePrivateSend = (source: "encrypted" | "public") => runAction(
    source === "encrypted" ? "Creating private UTXO from encrypted balance..." : "Creating private UTXO from public balance...",
    async () => {
      ensureToken(selectedToken);
      if (!owner || !umbraNetwork) throw new Error("Create or unlock a Vaulkyrie wallet first.");
      const recipient = privateDestination.trim();
      if (!recipient) throw new Error("Enter a registered Umbra recipient address.");
      const amountAtomic = parseUiAmount(amount, selectedToken.decimals);
      const client = await createUmbraWalletClient(owner, network);
      setStatus("Checking recipient registration...");
      await waitForUiPaint();
      const recipientState = await client.queryAccountState(recipient);
      if (!recipientState.anonymous) {
        throw new Error("Recipient is not registered for Umbra anonymous transfers yet.");
      }

      if (source === "encrypted") {
        const pendingEncryptedActivity = activities.find((activity) =>
          activity.status === "pending"
          && activity.mint === selectedToken.mint
          && (activity.kind === "deposit" || activity.kind === "withdraw" || activity.kind === "private-send"),
        );
        if (pendingEncryptedActivity) {
          throw new Error(
            `A previous ${pendingEncryptedActivity.kind.replace("-", " ")} for ${selectedToken.symbol} is still awaiting Umbra callback finalization. Refresh this wallet and try again after it settles.`,
          );
        }

        setStatus(`Refreshing ${selectedToken.symbol} shielded balance...`);
        await waitForUiPaint();
        const freshBalance = await handlePostMutationRefresh(client, selectedToken);
        if (freshBalance.state === "error") {
          throw new Error(
            freshBalance.error
              ?? `The stored Umbra seed for this vault does not match the encrypted ${selectedToken.symbol} balance.`,
          );
        }
        if (freshBalance.state !== "shared") {
          throw new Error(
            `Your shielded ${selectedToken.symbol} balance is not ready yet. Wait for the shielding callback to finalize, then refresh and try again.`,
          );
        }

        const availableAtomic = BigInt(freshBalance.balanceAtomic ?? "0");
        if (availableAtomic < amountAtomic) {
          throw new Error(
            `Only ${freshBalance.balanceUi ?? "0"} shielded ${selectedToken.symbol} is currently available. Reduce the amount or refresh after pending Umbra callbacks complete.`,
          );
        }

        setStatus("Downloading proving key and generating the private transfer proof. This can take a while on first use...");
        await waitForUiPaint();
        const result = await client.privateSendFromEncryptedBalance({
          destinationAddress: recipient,
          mint: selectedToken.mint,
          amountAtomic,
        });
        recordActivity({
          kind: "private-send",
          status: result.callbackStatus === "timed-out" || result.callbackStatus === "pruned" ? "pending" : "confirmed",
          mint: selectedToken.mint,
          symbol: selectedToken.symbol,
          amountAtomic: amountAtomic.toString(),
          amountUi: formatAtomicAmount(amountAtomic, selectedToken.decimals),
          recipient,
          queueSignature: result.queueSignature,
          callbackSignature: result.callbackSignature,
          callbackStatus: result.callbackStatus,
        });
      } else {
        setStatus("Downloading proving key and generating the private transfer proof. This can take a while on first use...");
        await waitForUiPaint();
        const result = await client.privateSendFromPublicBalance({
          destinationAddress: recipient,
          mint: selectedToken.mint,
          amountAtomic,
        });
        recordActivity({
          kind: "private-send",
          status: "confirmed",
          mint: selectedToken.mint,
          symbol: selectedToken.symbol,
          amountAtomic: amountAtomic.toString(),
          amountUi: formatAtomicAmount(amountAtomic, selectedToken.decimals),
          recipient,
          queueSignature: result.createUtxoSignature,
        });
      }
      setAmount("");
      setPrivateDestination("");
      await handlePostMutationRefresh(client, selectedToken);
      void refreshAll();
    },
  );

  const handleScanIncoming = () => runAction("Scanning Umbra mixer for incoming notes...", async () => {
    if (!owner || !umbraNetwork) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    const client = await createUmbraWalletClient(owner, network);
    const accountState = await syncAccountState(client);
    const total = await refreshIncomingNotes(client, accountState);
    recordActivity({
      kind: "query",
      status: "confirmed",
      utxoCount: total,
    });
  });

  const handleClaimIncoming = () => runAction("Claiming incoming private notes...", async () => {
    ensureToken(selectedToken);
    if (!owner || !umbraNetwork) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    if (receivedUtxos.length === 0) throw new Error("Scan first, then claim when incoming private notes are available.");
    const nextScanStartIndex = incomingUtxos?.nextScanStartIndex;
    const client = await createUmbraWalletClient(owner, network);
    const result = await client.claimIncomingToEncryptedBalance(receivedUtxos);
    const batches = Array.from(result.batches.values());
    const failed = batches.find((batch) => batch.status === "failed" || batch.status === "timed_out");
    recordActivity({
      kind: "private-claim",
      status: failed ? "failed" : "confirmed",
      mint: selectedToken.mint,
      symbol: selectedToken.symbol,
      batchCount: batches.length,
      utxoCount: receivedUtxos.length,
      queueSignature: batches.find((batch) => batch.txSignature)?.txSignature,
      callbackSignature: batches.find((batch) => batch.callbackSignature)?.callbackSignature,
      error: failed?.failureReason ?? undefined,
    });
    if (failed) {
      throw new Error(failed.failureReason ?? "Umbra relayer failed to claim one or more incoming notes.");
    }
    const latestRecord = getLatestUmbraAccountRecord(owner, umbraNetwork);
    if (nextScanStartIndex !== undefined) {
      persistAccount({
        nextInboxScanStartIndex: nextScanStartIndex,
        claimedInboxNoteKeys: mergeUniqueKeys(
          latestRecord?.claimedInboxNoteKeys ?? [],
          receivedUtxos.map(buildIncomingNoteKey),
        ),
      });
    }
    setIncomingUtxos(createEmptyIncomingUtxos(nextScanStartIndex));
    const balances = await client.queryBalances(tokenOptions);
    persistAccount({
      balances: balances.reduce<Record<string, typeof balances[number]>>((next, item) => {
        next[item.mint] = item;
        return next;
      }, {}),
    });
  });

  const handleWrapSol = () => runAction("Wrapping SOL into wSOL...", async () => {
    ensureToken(selectedToken);
    if (!owner) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    if (!isWrappedSol) throw new Error("Select wSOL before wrapping native SOL.");
    const lamports = parseUiAmount(amount, selectedToken.decimals);
    const signature = await wrapSolForVault(
      createConnection(network),
      owner,
      lamports,
      (message) => setStatus(message),
    );
    recordActivity({
      kind: "wrap",
      status: "confirmed",
      mint: selectedToken.mint,
      symbol: selectedToken.symbol,
      amountAtomic: lamports.toString(),
      amountUi: formatAtomicAmount(lamports, selectedToken.decimals),
      queueSignature: signature,
    });
    setAmount("");
    await refreshAll();
  });

  const handleUnwrapSol = () => runAction("Unwrapping public wSOL into SOL...", async () => {
    if (!owner) throw new Error("Create or unlock a Vaulkyrie wallet first.");
    if (!isWrappedSol) throw new Error("Select wSOL before unwrapping.");
    const signature = await unwrapAllSolForVault(
      createConnection(network),
      owner,
      (message) => setStatus(message),
    );
    recordActivity({
      kind: "unwrap",
      status: "confirmed",
      mint: selectedToken?.mint,
      symbol: selectedToken?.symbol ?? "wSOL",
      queueSignature: signature,
    });
    await refreshAll();
  });

  const handlePostMutationRefresh = async (
    client: Awaited<ReturnType<typeof createUmbraWalletClient>>,
    token: UmbraTokenConfig,
  ) => {
    const [updated] = await client.queryBalances([token]);
    const latestRecord = getLatestUmbraAccountRecord(owner, umbraNetwork);
    persistAccount({
      balances: {
        ...(latestRecord?.balances ?? {}),
        [token.mint]: updated,
      },
    });
    return updated;
  };

  const receiveUri = owner ? `solana:${owner}?label=Vaulkyrie%20Umbra` : "no-address";

  const renderActiveSection = () => {
    switch (activeSection) {
      case "overview":
        return (
          <div className="space-y-3">
            <Card className="p-3">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 p-2 text-primary">
                  <Shield className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold">Encrypted account</p>
                    <Badge variant={registrationReady ? "success" : needsRegistrationFunding ? "warning" : "outline"}>
                      {registrationReady ? "Ready" : needsRegistrationFunding ? "Fund first" : "Setup required"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Register once to enable shielded balances and private receives.
                  </p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <SummaryTile
                  label="Wallet gas"
                  value={`${nativeSolBalance.toFixed(4)} SOL`}
                  tone={needsRegistrationFunding ? "default" : "primary"}
                />
                <SummaryTile
                  label="Registration"
                  value={registrationReady ? "Complete" : needsRegistrationFunding ? "Needs funding" : "Ready to start"}
                  tone={registrationReady ? "primary" : "default"}
                />
              </div>
              {needsRegistrationFunding && (
                <div className="mt-4 rounded-2xl border border-warning/35 bg-warning/10 px-3 py-3 text-xs text-warning">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-2">
                      <p className="font-medium text-foreground">Fund this Privacy Vault before registering.</p>
                      <p>Fund at least {REGISTER_MIN_SOL.toFixed(2)} SOL first.</p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {network === "devnet" ? (
                      <Button variant="secondary" onClick={handleDevnetAirdrop} disabled={isBusy || !owner}>
                        Request {DEVNET_AIRDROP_SOL} devnet SOL
                      </Button>
                    ) : (
                      <Button
                        variant={isCopied("umbra-fund-address") ? "secondary" : "outline"}
                        onClick={() => copy(owner, "umbra-fund-address")}
                        disabled={!owner}
                      >
                        {isCopied("umbra-fund-address") ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        {isCopied("umbra-fund-address") ? "Copied address" : "Copy funding address"}
                      </Button>
                    )}
                    <Button
                      variant={isCopied("umbra-fund-address") ? "secondary" : "outline"}
                      onClick={() => copy(owner, "umbra-fund-address")}
                      disabled={!owner}
                    >
                      {isCopied("umbra-fund-address") ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {isCopied("umbra-fund-address") ? "Copied address" : "Copy vault address"}
                    </Button>
                  </div>
                </div>
              )}
              <Button
                className="mt-4 w-full"
                onClick={handleRegister}
                disabled={isBusy || isUnsupportedNetwork || !owner || needsRegistrationFunding}
              >
                <LockKeyhole className="h-4 w-4" />
                {registrationReady ? "Encrypted account ready" : "Register encrypted account"}
              </Button>
            </Card>

            <Card className="p-3">
              <p className="text-sm font-semibold">Supported pools</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {tokenOptions.map((token) => (
                  <div
                    key={token.mint}
                    className={cn(
                      "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs",
                      selectedToken?.mint === token.mint ? "border-primary/35 bg-primary/10 text-foreground" : "border-border/70 bg-background/70 text-muted-foreground",
                    )}
                  >
                    <TokenAvatar token={token} className="h-5 w-5" />
                    <span className="font-medium">{token.symbol}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        );
      case "balances":
        return (
          <Card className="p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">Shielded balance</p>
                </div>
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              </div>
              {selectedToken && (
                <div className="mb-3 flex items-center gap-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-3">
                  <TokenAvatar token={selectedToken} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{selectedToken.symbol}</p>
                    <p className="text-xs text-muted-foreground">{selectedToken.name}</p>
                  </div>
                  <Badge variant="outline">{umbraNetwork}</Badge>
                </div>
              )}
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
            <div className="mt-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Encrypted balance</p>
              <p className="mt-1 text-2xl font-semibold">{balanceSummary}</p>
              <p className="mt-1 text-xs text-muted-foreground">State: {balance?.state ?? "unknown"}</p>
              {balance?.error && (
                <p className="mt-2 text-xs text-destructive">{balance.error}</p>
              )}
            </div>
            <div className="mt-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Public wallet</p>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                <p>
                  Public {selectedToken?.symbol ?? "token"}: {publicTokenBalance.toFixed(selectedToken?.decimals === 9 ? 4 : 2)} {selectedToken?.symbol ?? ""}
                </p>
                {isWrappedSol && (
                  <>
                    <p>Native SOL in wallet: {nativeSolBalance.toFixed(4)} SOL</p>
                  </>
                )}
              </div>
              {wrappedSolSettlementNote && (
                <p className="mt-2 text-xs text-muted-foreground">{wrappedSolSettlementNote}</p>
              )}
            </div>
          </Card>
        );
      case "move":
        return (
            <Card className="p-3">
              <div className="mb-3 flex items-center gap-2">
                <WalletCards className="h-4 w-4 text-primary" />
                <p className="text-sm font-semibold">Move funds</p>
              </div>
              <div className="mt-3 space-y-3">
                {selectedToken && (
                  <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-3">
                    <TokenAvatar token={selectedToken} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{selectedToken.symbol}</p>
                      <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                        <p>Public {selectedToken.symbol}: {publicTokenBalance.toFixed(selectedToken.decimals === 9 ? 4 : 2)} available</p>
                        {isWrappedSol && <p>Native SOL in wallet: {nativeSolBalance.toFixed(4)} available</p>}
                      </div>
                    </div>
                  </div>
                )}
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
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Button className="w-full" variant="secondary" onClick={handleDeposit} disabled={isBusy || isUnsupportedNetwork || !selectedToken || !registrationReady}>
                    Shield
                  </Button>
                  <Button className="w-full" onClick={handleWithdraw} disabled={isBusy || isUnsupportedNetwork || !selectedToken || !registrationReady}>
                    Unshield
                  </Button>
                </div>
                {wrappedSolSettlementNote && (
                  <div className="rounded-2xl border border-border/70 bg-background/70 px-3 py-3 text-xs text-muted-foreground">
                    {wrappedSolSettlementNote}
                  </div>
                )}
                {isWrappedSol && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={handleWrapSol}
                      disabled={isBusy || nativeSolBalance <= 0}
                    >
                      <Repeat2 className="h-4 w-4" />
                      Wrap SOL
                    </Button>
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={handleUnwrapSol}
                      disabled={isBusy || publicWrappedSolBalance <= 0}
                    >
                      Unwrap all
                    </Button>
                  </div>
                )}
            </div>
          </Card>
        );
      case "transfer":
        return (
            <Card className="p-3">
              <div className="mb-3 flex items-center gap-2">
                <Send className="h-4 w-4 text-primary" />
                <p className="text-sm font-semibold">Private transfer</p>
              </div>
              <div className="mt-3 space-y-3">
                {selectedToken && (
                  <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-3">
                    <TokenAvatar token={selectedToken} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{selectedToken.symbol}</p>
                    </div>
                  </div>
                )}
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
              <Input
                inputMode="decimal"
                placeholder="Amount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <Input
                placeholder="Registered Umbra recipient address"
                value={privateDestination}
                onChange={(event) => setPrivateDestination(event.target.value)}
              />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Button className="w-full" variant="secondary" onClick={() => handlePrivateSend("encrypted")} disabled={isBusy || isUnsupportedNetwork || !selectedToken || !registrationReady}>
                    From shielded
                  </Button>
                  <Button className="w-full" variant="outline" onClick={() => handlePrivateSend("public")} disabled={isBusy || isUnsupportedNetwork || !selectedToken || !registrationReady}>
                    From public
                  </Button>
                </div>
              </div>
            </Card>
        );
      case "inbox":
        return (
          <Card className="p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Inbox className="h-4 w-4 text-primary" />
                <p className="text-sm font-semibold">Incoming private notes</p>
              </div>
              <Badge variant={receivedUtxos.length > 0 ? "success" : "outline"}>{receivedUtxos.length} found</Badge>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 px-3 py-3">
              <p className="text-xs text-muted-foreground">
                {receivedUtxos.length > 0
                  ? "Claiming moves scanned notes into your encrypted balance."
                  : "Refresh or scan notes, then claim them when available."}
              </p>
              {(incomingUtxos?.nextScanStartIndex ?? record?.nextInboxScanStartIndex) !== undefined && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Next scan starts at mixer index {incomingUtxos?.nextScanStartIndex ?? record?.nextInboxScanStartIndex}.
                </p>
              )}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button className="w-full" variant="outline" onClick={handleScanIncoming} disabled={isBusy || isUnsupportedNetwork || !owner}>
                Scan notes
              </Button>
              <Button className="w-full" onClick={handleClaimIncoming} disabled={isBusy || isUnsupportedNetwork || receivedUtxos.length === 0 || !registrationReady}>
                Claim private
              </Button>
            </div>
          </Card>
        );
      case "receive":
        return (
          <Card className="p-3">
            <div className="mb-3 flex items-center gap-2">
              <QrCode className="h-4 w-4 text-primary" />
              <p className="text-sm font-semibold">Private receive card</p>
            </div>
            <div className="flex flex-col items-center rounded-2xl border border-border/70 bg-background/70 p-4 text-center">
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
        );
      case "activity":
        return (
          <Card className="p-3">
            <p className="text-sm font-semibold">Recent privacy activity</p>
            <div className="mt-3 space-y-2">
              {activities.length === 0 ? (
                <p className="text-xs text-muted-foreground">No privacy activity yet.</p>
              ) : (
                activities.slice(0, 8).map((activity) => (
                  <div key={activity.id} className="rounded-2xl border border-border/60 bg-background/60 px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium capitalize">{activity.kind.replace("-", " ")}</p>
                      <Badge variant={activity.status === "failed" ? "destructive" : activity.status === "pending" ? "warning" : "success"}>
                        {activity.status}
                      </Badge>
                    </div>
                    {activity.amountUi && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {activity.amountUi} {activity.symbol}
                      </p>
                    )}
                    {activity.recipient && (
                      <p className="mt-1 truncate text-[10px] font-mono text-muted-foreground">
                        To {activity.recipient}
                      </p>
                    )}
                    {activity.utxoCount !== undefined && (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {activity.utxoCount} private note{activity.utxoCount === 1 ? "" : "s"}
                      </p>
                    )}
                    {activity.queueSignature && (
                      <p className="mt-1 truncate text-[10px] font-mono text-muted-foreground">
                        {activity.queueSignature}
                      </p>
                    )}
                    {activity.error && (
                      <p className="mt-1 text-[10px] text-destructive">{activity.error}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>
        );
      default:
        return null;
    }
  };

  return (
    <ScreenShell
      title="Privacy"
      description={
        activeAccountKind === "privacy-vault"
          ? "Use Umbra with a dedicated Privacy Vault and native local signing."
          : "Use Umbra as a privacy rail on top of your Vaulkyrie threshold vault."
      }
      onBack={() => onNavigate("dashboard")}
      backLabel="Back to dashboard"
      actions={(
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isBusy || isUnsupportedNetwork || !owner}>
          <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      )}
    >
      <div className="space-y-3">
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

        <Card className="p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">Privacy cockpit</p>
                <Badge variant={registrationReady ? "success" : "outline"}>
                  {registrationReady ? "Ready" : "Needs setup"}
                </Badge>
              </div>
            </div>
            <Badge variant="outline">{umbraNetwork ?? "unsupported"}</Badge>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SummaryTile label="Vault" value={owner ? shortenAddress(owner, 6) : "No wallet"} tone="primary" />
            <SummaryTile label="Selected token" value={selectedToken?.symbol ?? "None"} />
            <SummaryTile label="Shielded" value={balanceSummary} />
            <SummaryTile label="Inbox" value={`${inboxNoteCount} note${inboxNoteCount === 1 ? "" : "s"}`} />
          </div>
        </Card>

        <div className="space-y-2">
          {PRIVACY_SECTION_ITEMS.map((item) => (
            <SectionButton
              key={item.id}
              icon={item.icon}
              label={item.label}
              detail={item.detail}
              badge={item.id === "inbox" && inboxNoteCount > 0 ? String(inboxNoteCount) : undefined}
              isActive={activeSection === item.id}
              onClick={() => setActiveSection(item.id)}
            />
          ))}
        </div>

        {renderActiveSection()}
      </div>
    </ScreenShell>
  );
}

function ensureToken(token: UmbraTokenConfig | undefined): asserts token is UmbraTokenConfig {
  if (!token) {
    throw new Error("Select a supported Umbra token first.");
  }
}

function buildFundingError(network: string): string {
  return network === "devnet"
    ? `Fund this Privacy Vault with at least ${REGISTER_MIN_SOL.toFixed(2)} SOL before registering. New devnet vaults do not exist on-chain until they receive SOL, so Umbra setup cannot create accounts yet.`
    : `Fund this Privacy Vault with at least ${REGISTER_MIN_SOL.toFixed(2)} SOL before registering. Umbra setup needs SOL for rent and transaction fees.`;
}

async function waitForUiPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function readNestedCode(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.__code === "number") return record.__code;
  if (typeof record.code === "number") return record.code;
  return null;
}

function readNestedString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") {
    return record[key] as string;
  }
  return readNestedString(record.context, key) ?? readNestedString(record.cause, key);
}

function normalizePrivacyError(
  error: unknown,
  context: { network: string; publicSolBalance: number },
): string {
  const fallback = formatUmbraErrorMessage(error);
  const root = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const cause = root?.cause;
  const rootCode = readNestedCode(root?.context) ?? readNestedCode(root);
  const causeCode =
    readNestedCode(cause) ??
    (cause && typeof cause === "object" ? readNestedCode((cause as Record<string, unknown>).context) : null);
  const stage = readNestedString(error, "stage");

  if ((rootCode === 7050003 || causeCode === 7050003) && context.publicSolBalance < REGISTER_MIN_SOL) {
    return buildFundingError(context.network === "devnet" ? "devnet" : "mainnet");
  }

  if (/account not found/i.test(fallback) && context.publicSolBalance < REGISTER_MIN_SOL) {
    return buildFundingError(context.network === "devnet" ? "devnet" : "mainnet");
  }

  if (/insufficient funds/i.test(fallback)) {
    return "This vault needs more SOL for fees or more token balance for the selected action.";
  }

  if (stage === "zk-proof-generation") {
    return `${fallback} Keep this browser tab open while Umbra finishes generating the proof locally.`;
  }

  if (stage === "transaction-validate") {
    return `${fallback} Umbra rejected the transfer during preflight, which usually means the shielded balance, recipient state, or pool state was not ready yet. Refresh both wallets and try again.`;
  }

  return fallback;
}

function countClaimableIncomingNotes(utxos: UmbraIncomingUtxos | null | undefined): number {
  if (!utxos) {
    return 0;
  }

  return utxos.received.length + utxos.publicReceived.length;
}

function createEmptyIncomingUtxos(nextScanStartIndex?: number): UmbraIncomingUtxos {
  return {
    received: [],
    publicReceived: [],
    selfBurnable: [],
    publicSelfBurnable: [],
    nextScanStartIndex,
  };
}

function getLatestUmbraAccountRecord(
  owner: string,
  network: UmbraAccountRecord["network"] | null,
): UmbraAccountRecord | null {
  if (!network) {
    return null;
  }

  return useWalletStore.getState().getUmbraAccount(owner, network);
}

function buildIncomingNoteKey(utxo: UmbraIncomingUtxos["received"][number]): string {
  return `${String(utxo.treeIndex)}:${String(utxo.insertionIndex)}:${utxo.unlockerType}`;
}

function mergeUniqueKeys(existing: readonly string[], next: readonly string[]): string[] {
  return [...new Set([...existing, ...next])];
}

function filterClaimedIncomingNotes(
  utxos: UmbraIncomingUtxos,
  claimedKeys: ReadonlySet<string>,
): UmbraIncomingUtxos {
  if (claimedKeys.size === 0) {
    return utxos;
  }

  return {
    ...utxos,
    received: utxos.received.filter((utxo) => !claimedKeys.has(buildIncomingNoteKey(utxo))),
    publicReceived: utxos.publicReceived.filter((utxo) => !claimedKeys.has(buildIncomingNoteKey(utxo))),
  };
}
