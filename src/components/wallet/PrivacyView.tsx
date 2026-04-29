import { useEffect, useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  AlertCircle,
  Check,
  Copy,
  Eye,
  FileKey2,
  Loader2,
  LockKeyhole,
  QrCode,
  Shield,
  Shuffle,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { ScreenShell } from "@/components/layout/ScreenShell";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { NETWORKS } from "@/lib/constants";
import { shortenAddress } from "@/lib/utils";
import {
  createConnection,
} from "@/services/solanaRpc";
import {
  executeEncifherSwap,
  fetchEncifherOrderStatus,
  fetchEncifherQuote,
  fetchEncifherStatus,
  prepareEncifherDepositTx,
  prepareEncifherSwapTx,
  prepareEncifherWithdrawTx,
  type EncifherExecuteResult,
  type EncifherQuote,
  type EncifherStatus,
} from "@/services/privacy/encifherClient";
import { signSerializedTransaction } from "@/services/frost/signTransaction";
import { useWalletStore } from "@/store/walletStore";
import {
  PRIVACY_DECISION_LINKABILITY_WARNING,
  PRIVACY_FLAG_NATIVE_SHIELDED,
  PRIVACY_FLAG_ONE_TIME_ADDRESS,
  PRIVACY_FLAG_PROVIDER_ROUTE,
  PRIVACY_FLAG_SELECTIVE_DISCLOSURE,
  PRIVACY_FLAG_STEALTH_RECIPIENT,
  PRIVACY_FLAG_SWAP_INTENT,
  PRIVACY_FLAG_WITHDRAW_LINKABLE,
  createPrivacyReceipt,
  derivePrivacyAccountMaterial,
  type PrivacyDisclosureModeId,
  type PrivacyPoolBucketId,
  type PrivacyRouteRiskId,
} from "@/sdk/privacyEngine";
import type {
  PrivacyActionId,
  PrivacyAssetSymbol,
  PrivacyExecutionModelId,
  WalletView,
} from "@/types";

interface PrivacyViewProps {
  onNavigate: (view: WalletView) => void;
}

const ACTION_LABEL: Record<PrivacyActionId, string> = {
  deposit: "Shield deposit",
  transfer: "Private send",
  withdraw: "Withdraw",
  swapIntent: "Private swap",
  sealReceipt: "Seal receipt",
};

const EXECUTION_LABEL: Record<PrivacyExecutionModelId, string> = {
  shieldedState: "Shielded balance",
  externalPrivateSwap: "Encifher private swap",
  confidentialIntent: "Confidential intent",
  oneTimeWallet: "One-time receive",
};

const ENCFIHER_MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
} as const;

function disclosureLabel(mode: PrivacyDisclosureModeId): string {
  if (mode === "businessAudit") return "Business audit";
  if (mode === "selectiveAudit") return "Selective audit";
  if (mode === "userReceipt") return "User receipt";
  return "None";
}

function executionModelFor(action: PrivacyActionId): PrivacyExecutionModelId {
  if (action === "swapIntent") return "externalPrivateSwap";
  if (action === "sealReceipt") return "oneTimeWallet";
  if (action === "transfer") return "confidentialIntent";
  return "shieldedState";
}

function privacyFlagsFor(action: PrivacyActionId, disclosureMode: PrivacyDisclosureModeId): number {
  let flags = PRIVACY_FLAG_STEALTH_RECIPIENT | PRIVACY_FLAG_ONE_TIME_ADDRESS;

  if (action === "swapIntent") {
    flags |= PRIVACY_FLAG_PROVIDER_ROUTE | PRIVACY_FLAG_SWAP_INTENT;
  } else {
    flags |= PRIVACY_FLAG_NATIVE_SHIELDED;
  }
  if (disclosureMode !== "none") {
    flags |= PRIVACY_FLAG_SELECTIVE_DISCLOSURE;
  }
  if (action === "withdraw") {
    flags |= PRIVACY_FLAG_WITHDRAW_LINKABLE;
  }

  return flags;
}

function defaultRouteRisk(action: PrivacyActionId): PrivacyRouteRiskId {
  if (action === "withdraw") return "high";
  if (action === "swapIntent") return "medium";
  return "low";
}

function scoreTone(score: number): string {
  if (score >= 80) return "text-success";
  if (score >= 55) return "text-amber-300";
  return "text-destructive";
}

function toBaseUnits(amount: number, decimals: number): string {
  return BigInt(Math.max(0, Math.round(amount * 10 ** decimals))).toString();
}

function encifherModeLabel(status: EncifherStatus | null): string {
  if (!status) return "Checking relay";
  if (!status.enabled) return "Relay key missing";
  return `${status.mode} rail`;
}

async function submitSignedBase64(connection: Connection, signedTransactionBase64: string): Promise<string> {
  return connection.sendRawTransaction(Buffer.from(signedTransactionBase64, "base64"), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
}

export function PrivacyView({ onNavigate }: PrivacyViewProps) {
  const {
    activeAccount,
    network,
    relayUrl,
    privacyAccounts,
    privacyReceipts,
    upsertPrivacyAccount,
    recordPrivacyReceipt,
    refreshBalances,
  } = useWalletStore();
  const { copy, isCopied, copyError } = useCopyToClipboard({ resetAfterMs: 1800 });

  const ownerPublicKey = activeAccount?.publicKey ?? "";
  const accounts = useMemo(
    () => (ownerPublicKey ? privacyAccounts[ownerPublicKey] ?? [] : []),
    [ownerPublicKey, privacyAccounts],
  );
  const receipts = useMemo(
    () => (ownerPublicKey ? privacyReceipts[ownerPublicKey] ?? [] : []),
    [ownerPublicKey, privacyReceipts],
  );

  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountLabel, setAccountLabel] = useState("Private account");
  const [action, setAction] = useState<PrivacyActionId>("swapIntent");
  const [asset, setAsset] = useState<PrivacyAssetSymbol>("USDC");
  const [disclosureMode, setDisclosureMode] = useState<PrivacyDisclosureModeId>("selectiveAudit");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<EncifherStatus | null>(null);
  const [quote, setQuote] = useState<EncifherQuote | null>(null);
  const [txSignature, setTxSignature] = useState("");
  const [orderStatus, setOrderStatus] = useState("");

  const activePrivacyAccount = accounts.find((item) => item.id === selectedAccountId) ?? accounts[0] ?? null;
  const poolBucket: PrivacyPoolBucketId = receipts.length > 8 ? "healthy" : receipts.length > 2 ? "building" : "thin";
  const parsedAmount = Number.parseFloat(amount) || 0;
  const executionModel = executionModelFor(action);
  const canCreateIntent = Boolean(ownerPublicKey && activePrivacyAccount && parsedAmount > 0 && !isWorking);
  const needsMainnet = action === "swapIntent" || action === "deposit" || action === "withdraw";
  const encifherReady = Boolean(status?.enabled && status.mode === "Mainnet" && network === "mainnet");

  useEffect(() => {
    let cancelled = false;
    fetchEncifherStatus(relayUrl)
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch((statusError) => {
        if (!cancelled) setError(statusError instanceof Error ? statusError.message : String(statusError));
      });
    return () => {
      cancelled = true;
    };
  }, [relayUrl]);

  const handleCreateAccount = async () => {
    if (!ownerPublicKey) {
      setError("No active wallet selected.");
      return;
    }

    setIsWorking(true);
    setError("");
    try {
      const now = Date.now();
      const material = await derivePrivacyAccountMaterial(ownerPublicKey, accountLabel.trim() || "Private account", now);
      const account = {
        id: material.id,
        ownerPublicKey,
        label: accountLabel.trim() || "Private account",
        network,
        receiveCode: material.receiveCode,
        scanPublicKey: material.scanPublicKey,
        spendPublicKeyCommitment: material.spendPublicKeyCommitment,
        viewingKeyCommitment: material.viewingKeyCommitment,
        supportedAssets: ["SOL", "USDC"] as PrivacyAssetSymbol[],
        createdAt: now,
        updatedAt: now,
      };
      upsertPrivacyAccount(ownerPublicKey, account);
      setSelectedAccountId(account.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create privacy account.");
    } finally {
      setIsWorking(false);
    }
  };

  const createLocalReceipt = async (signatureHint?: string) => {
    if (!ownerPublicKey || !activePrivacyAccount) return;

    const receipt = await createPrivacyReceipt({
      accountId: activePrivacyAccount.id,
      ownerPublicKey,
      network,
      action,
      asset,
      amount: parsedAmount,
      executionModel,
      recipientHint: signatureHint ?? (recipient.trim() || null),
      disclosureMode,
      poolBucket,
      routeRisk: defaultRouteRisk(action),
      flags: privacyFlagsFor(action, disclosureMode),
    });
    recordPrivacyReceipt(ownerPublicKey, receipt);
  };

  const handleQuote = async () => {
    setError("");
    setQuote(null);
    if (!encifherReady) {
      setError("Encifher private swaps require mainnet and ENCIFHER_SDK_KEY on the relay server.");
      return;
    }
    if (parsedAmount <= 0) {
      setError("Enter an amount first.");
      return;
    }

    setIsWorking(true);
    try {
      const nextQuote = await fetchEncifherQuote({
        relayUrl,
        inMint: ENCFIHER_MINTS.USDC,
        outMint: ENCFIHER_MINTS.USDT,
        amountIn: toBaseUnits(parsedAmount, 6),
      });
      setQuote(nextQuote);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch Encifher quote.");
    } finally {
      setIsWorking(false);
    }
  };

  const handleCreateIntent = async () => {
    setIsWorking(true);
    setError("");
    try {
      await createLocalReceipt();
      setAmount("");
      if (action !== "transfer") setRecipient("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create privacy receipt.");
    } finally {
      setIsWorking(false);
    }
  };

  const handleExecuteEncifher = async () => {
    if (!ownerPublicKey) {
      setError("No active wallet selected.");
      return;
    }
    if (!encifherReady) {
      setError(`Encifher execution is available on mainnet only. Current network: ${NETWORKS[network].name}.`);
      return;
    }
    if (parsedAmount <= 0) {
      setError("Enter an amount first.");
      return;
    }

    setIsWorking(true);
    setError("");
    setTxSignature("");
    setOrderStatus("");
    try {
      const connection = createConnection(network);
      const amountIn = toBaseUnits(parsedAmount, 6);
      const owner = new PublicKey(ownerPublicKey).toBase58();

      if (action === "deposit") {
        const prepared = await prepareEncifherDepositTx({
          relayUrl,
          depositor: owner,
          tokenSymbol: "USDC",
          amount: amountIn,
        });
        const signed = await signSerializedTransaction(prepared.transaction, owner, prepared.transactionKind);
        const signature = await submitSignedBase64(connection, signed.signedTransactionBase64);
        setTxSignature(signature);
        await createLocalReceipt(signature);
        await refreshBalances();
        return;
      }

      if (action === "withdraw") {
        const receiver = recipient.trim() || owner;
        const prepared = await prepareEncifherWithdrawTx({
          relayUrl,
          withdrawer: owner,
          receiver,
          tokenSymbol: "USDC",
          amount: amountIn,
        });
        const signed = await signSerializedTransaction(prepared.transaction, owner, prepared.transactionKind);
        const signature = await submitSignedBase64(connection, signed.signedTransactionBase64);
        setTxSignature(signature);
        await createLocalReceipt(signature);
        await refreshBalances();
        return;
      }

      if (action === "swapIntent") {
        const receiver = recipient.trim() ? new PublicKey(recipient.trim()).toBase58() : owner;
        const prepared = await prepareEncifherSwapTx({
          relayUrl,
          inMint: ENCFIHER_MINTS.USDC,
          outMint: ENCFIHER_MINTS.USDT,
          amountIn,
          senderPubkey: owner,
          receiverPubkey: receiver,
          message: activePrivacyAccount?.receiveCode,
        });
        const signed = await signSerializedTransaction(prepared.transaction, owner, prepared.transactionKind);
        const result: EncifherExecuteResult = await executeEncifherSwap({
          relayUrl,
          signedTransactionBase64: signed.signedTransactionBase64,
          orderDetails: prepared.orderDetails,
        });
        setTxSignature(result.txHash);
        await createLocalReceipt(result.txHash);
        const nextStatus = await fetchEncifherOrderStatus({
          relayUrl,
          orderStatusIdentifier: result.orderStatusIdentifier,
        });
        setOrderStatus(nextStatus);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Encifher execution failed.");
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <ScreenShell
      title="Privacy"
      description="Shield balances, prepare private swaps, and keep audit receipts separate from public wallet history."
      onBack={() => onNavigate("dashboard")}
      backLabel="Back to dashboard"
      actions={(
        <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary">
          {encifherModeLabel(status)}
        </span>
      )}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <Card className="p-3">
            <LockKeyhole className="mb-2 h-4 w-4 text-primary" />
            <p className="text-xs font-semibold">Shield</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Wrap USDC into a private balance rail.</p>
          </Card>
          <Card className="p-3">
            <Shuffle className="mb-2 h-4 w-4 text-primary" />
            <p className="text-xs font-semibold">Swap</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Execute a private USDC to USDT order.</p>
          </Card>
          <Card className="p-3">
            <FileKey2 className="mb-2 h-4 w-4 text-primary" />
            <p className="text-xs font-semibold">Receipt</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Keep selective disclosure commitments.</p>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Private Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {accounts.length > 0 && (
              <SelectField
                value={activePrivacyAccount?.id ?? ""}
                onChange={(event) => setSelectedAccountId(event.target.value)}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label} · {shortenAddress(account.id, 6)}
                  </option>
                ))}
              </SelectField>
            )}

            <div className="flex gap-2">
              <Input
                value={accountLabel}
                onChange={(event) => setAccountLabel(event.target.value)}
                placeholder="Private account label"
              />
              <Button variant="secondary" onClick={handleCreateAccount} disabled={isWorking || !ownerPublicKey}>
                {isWorking && !activePrivacyAccount ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Create
              </Button>
            </div>

            {activePrivacyAccount ? (
              <div className="rounded-xl border border-border/70 bg-background/50 p-3">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-white p-2">
                    <QRCodeSVG value={activePrivacyAccount.receiveCode} size={96} bgColor="#ffffff" fgColor="#0a0a0a" level="M" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">{activePrivacyAccount.label}</p>
                    <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                      {activePrivacyAccount.receiveCode}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        variant={isCopied("privacy-receive") ? "secondary" : "outline"}
                        onClick={() => copy(activePrivacyAccount.receiveCode, "privacy-receive")}
                      >
                        {isCopied("privacy-receive") ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        Copy
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copy(activePrivacyAccount.viewingKeyCommitment, "privacy-view")}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        View key
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border/80 p-4 text-center">
                <QrCode className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
                <p className="text-sm font-medium">No privacy account yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Create one to generate receive codes and local disclosure commitments.
                </p>
              </div>
            )}
            {copyError && <p className="text-xs text-destructive">{copyError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Private Swap Rail</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <SelectField value={action} onChange={(event) => setAction(event.target.value as PrivacyActionId)}>
                <option value="swapIntent">Private USDC to USDT swap</option>
                <option value="deposit">Shield USDC</option>
                <option value="withdraw">Withdraw USDC</option>
                <option value="transfer">Private send intent</option>
                <option value="sealReceipt">Seal receipt</option>
              </SelectField>
              <SelectField value={asset} onChange={(event) => setAsset(event.target.value as PrivacyAssetSymbol)}>
                <option value="USDC">USDC</option>
                <option value="SOL">SOL receipt only</option>
              </SelectField>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-border bg-background/60 px-3 py-2 text-xs">
                <p className="text-[10px] text-muted-foreground">Execution</p>
                <p className="mt-1 font-medium">{EXECUTION_LABEL[executionModel]}</p>
              </div>
              <SelectField value={disclosureMode} onChange={(event) => setDisclosureMode(event.target.value as PrivacyDisclosureModeId)}>
                <option value="selectiveAudit">Selective audit</option>
                <option value="userReceipt">User receipt</option>
                <option value="businessAudit">Business audit</option>
                <option value="none">No disclosure</option>
              </SelectField>
            </div>

            <Input
              type="number"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder={action === "swapIntent" ? "USDC amount to swap" : `Amount in ${asset}`}
              min="0"
              step="0.01"
            />
            <Input
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              placeholder={action === "withdraw" ? "Optional receiver address" : "Optional receiver address or private note"}
            />

            {needsMainnet && network !== "mainnet" && (
              <div className="flex gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-3 text-xs text-amber-200">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Encifher swaps are mainnet-only. Switch to Mainnet before executing deposits, swaps, or withdrawals.
              </div>
            )}
            {status && !status.enabled && (
              <div className="flex gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 text-xs text-muted-foreground">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {status.reason}
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}

            {quote && (
              <div className="rounded-xl border border-border bg-background/60 px-3 py-3 text-xs text-muted-foreground">
                <div className="flex justify-between">
                  <span>Estimated output</span>
                  <span className="font-medium text-foreground">{Number(quote.amountOut) / 1_000_000} USDT</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span>Router</span>
                  <span>{quote.router}</span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={handleCreateIntent} disabled={!canCreateIntent}>
                {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                Seal receipt
              </Button>
              <Button onClick={action === "swapIntent" ? handleQuote : handleExecuteEncifher} disabled={!canCreateIntent || (needsMainnet && !encifherReady)}>
                {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
                {action === "swapIntent" ? "Quote" : "Execute"}
              </Button>
            </div>
            {action === "swapIntent" && (
              <Button className="w-full" onClick={handleExecuteEncifher} disabled={!canCreateIntent || !encifherReady}>
                {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
                Sign and execute private swap
              </Button>
            )}
            {txSignature && (
              <p className="break-all font-mono text-[10px] text-muted-foreground">
                Submitted: {txSignature}{orderStatus ? ` · ${orderStatus}` : ""}
              </p>
            )}
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              The relay constructs Encifher transactions with the server SDK key. The vault still signs the Solana transaction locally, so the private swap rail does not expose API secrets to the browser.
            </p>
          </CardContent>
        </Card>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Recent Privacy Receipts</p>
            <span className="text-[10px] text-muted-foreground">{receipts.length} total</span>
          </div>

          {receipts.length === 0 ? (
            <Card className="p-4 text-center">
              <WalletCards className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-medium">No sealed receipts yet</p>
              <p className="mt-1 text-xs text-muted-foreground">Create a private action to produce the first local receipt.</p>
            </Card>
          ) : (
            receipts.slice(0, 8).map((receipt) => {
              const hasWarning = (receipt.decisionFlags & PRIVACY_DECISION_LINKABILITY_WARNING) !== 0;
              return (
                <Card key={receipt.id} className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        {ACTION_LABEL[receipt.action]} · {receipt.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} {receipt.asset}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {EXECUTION_LABEL[receipt.executionModel]} · {disclosureLabel(receipt.disclosureMode)} · {receipt.minConfirmations} confirmation{receipt.minConfirmations === 1 ? "" : "s"}
                      </p>
                      <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
                        {receipt.receiptCommitment}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-semibold ${scoreTone(receipt.privacyScore)}`}>{receipt.privacyScore}</p>
                      <p className="text-[10px] text-muted-foreground">score</p>
                      {hasWarning && <p className="mt-1 text-[10px] text-amber-300">linkability</p>}
                    </div>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </ScreenShell>
  );
}
