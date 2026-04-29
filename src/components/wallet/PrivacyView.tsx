import { useMemo, useState } from "react";
import {
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
import { shortenAddress } from "@/lib/utils";
import type {
  PrivacyActionId,
  PrivacyAssetSymbol,
  PrivacyProviderId,
  WalletView,
} from "@/types";

interface PrivacyViewProps {
  onNavigate: (view: WalletView) => void;
}

const PROVIDER_LABEL: Record<PrivacyProviderId, string> = {
  nativeArcium: "Vaulkyrie Native",
  houdini: "Houdini",
  encifher: "Encifher",
  umbra: "Umbra",
};

const ACTION_LABEL: Record<PrivacyActionId, string> = {
  deposit: "Shield deposit",
  transfer: "Private send",
  withdraw: "Withdraw",
  swapIntent: "Private swap",
  sealReceipt: "Seal receipt",
};

function disclosureLabel(mode: PrivacyDisclosureModeId): string {
  if (mode === "businessAudit") return "Business audit";
  if (mode === "selectiveAudit") return "Selective audit";
  if (mode === "userReceipt") return "User receipt";
  return "None";
}

function privacyFlagsFor(
  action: PrivacyActionId,
  provider: PrivacyProviderId,
  disclosureMode: PrivacyDisclosureModeId,
): number {
  let flags = PRIVACY_FLAG_STEALTH_RECIPIENT | PRIVACY_FLAG_ONE_TIME_ADDRESS;

  if (provider === "nativeArcium") {
    flags |= PRIVACY_FLAG_NATIVE_SHIELDED;
  } else {
    flags |= PRIVACY_FLAG_PROVIDER_ROUTE;
  }
  if (disclosureMode !== "none") {
    flags |= PRIVACY_FLAG_SELECTIVE_DISCLOSURE;
  }
  if (action === "swapIntent") {
    flags |= PRIVACY_FLAG_SWAP_INTENT;
  }
  if (action === "withdraw") {
    flags |= PRIVACY_FLAG_WITHDRAW_LINKABLE;
  }

  return flags;
}

function defaultRouteRisk(action: PrivacyActionId, provider: PrivacyProviderId): PrivacyRouteRiskId {
  if (action === "withdraw") return "high";
  if (provider === "nativeArcium") return "low";
  return "medium";
}

function scoreTone(score: number): string {
  if (score >= 80) return "text-success";
  if (score >= 55) return "text-amber-300";
  return "text-destructive";
}

export function PrivacyView({ onNavigate }: PrivacyViewProps) {
  const {
    activeAccount,
    network,
    privacyAccounts,
    privacyReceipts,
    upsertPrivacyAccount,
    recordPrivacyReceipt,
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
  const [action, setAction] = useState<PrivacyActionId>("transfer");
  const [asset, setAsset] = useState<PrivacyAssetSymbol>("SOL");
  const [provider, setProvider] = useState<PrivacyProviderId>("nativeArcium");
  const [disclosureMode, setDisclosureMode] = useState<PrivacyDisclosureModeId>("selectiveAudit");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState("");

  const activePrivacyAccount = accounts.find((item) => item.id === selectedAccountId) ?? accounts[0] ?? null;
  const poolBucket: PrivacyPoolBucketId = receipts.length > 8 ? "healthy" : receipts.length > 2 ? "building" : "thin";
  const parsedAmount = Number.parseFloat(amount) || 0;
  const canCreateIntent = Boolean(ownerPublicKey && activePrivacyAccount && parsedAmount > 0 && !isWorking);

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

  const handleCreateIntent = async () => {
    if (!ownerPublicKey || !activePrivacyAccount) return;

    setIsWorking(true);
    setError("");
    try {
      const receipt = await createPrivacyReceipt({
        accountId: activePrivacyAccount.id,
        ownerPublicKey,
        network,
        action,
        asset,
        amount: parsedAmount,
        provider,
        recipientHint: recipient.trim() || null,
        disclosureMode,
        poolBucket,
        routeRisk: defaultRouteRisk(action, provider),
        flags: privacyFlagsFor(action, provider, disclosureMode),
      });
      recordPrivacyReceipt(ownerPublicKey, receipt);
      setAmount("");
      if (action !== "transfer") setRecipient("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create privacy intent.");
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <ScreenShell
      title="Privacy"
      description="Create private receive identities, Arcium-ready intents, and sealed receipts for shielded wallet flows."
      onBack={() => onNavigate("dashboard")}
      backLabel="Back to dashboard"
      actions={(
        <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary">
          SOL + USDC
        </span>
      )}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <Card className="p-3">
            <LockKeyhole className="mb-2 h-4 w-4 text-primary" />
            <p className="text-xs font-semibold">Shield</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Deposit into a private account.</p>
          </Card>
          <Card className="p-3">
            <Shuffle className="mb-2 h-4 w-4 text-primary" />
            <p className="text-xs font-semibold">Route</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Native or provider privacy paths.</p>
          </Card>
          <Card className="p-3">
            <FileKey2 className="mb-2 h-4 w-4 text-primary" />
            <p className="text-xs font-semibold">Disclose</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Seal receipts for audits.</p>
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
                  Create one to generate private receive codes and Arcium-bound intent commitments.
                </p>
              </div>
            )}
            {copyError && <p className="text-xs text-destructive">{copyError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Create Private Intent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <SelectField value={action} onChange={(event) => setAction(event.target.value as PrivacyActionId)}>
                <option value="deposit">Shield deposit</option>
                <option value="transfer">Private send</option>
                <option value="withdraw">Withdraw</option>
                <option value="swapIntent">Private swap</option>
                <option value="sealReceipt">Seal receipt</option>
              </SelectField>
              <SelectField value={asset} onChange={(event) => setAsset(event.target.value as PrivacyAssetSymbol)}>
                <option value="SOL">SOL</option>
                <option value="USDC">USDC</option>
              </SelectField>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <SelectField value={provider} onChange={(event) => setProvider(event.target.value as PrivacyProviderId)}>
                <option value="nativeArcium">Vaulkyrie Native</option>
                <option value="houdini">Houdini</option>
                <option value="encifher">Encifher</option>
                <option value="umbra">Umbra</option>
              </SelectField>
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
              placeholder={`Amount in ${asset}`}
              min="0"
              step={asset === "SOL" ? "0.000001" : "0.01"}
            />
            <Input
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              placeholder="Recipient private code, contact, or transparent address"
            />

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" onClick={handleCreateIntent} disabled={!canCreateIntent}>
              {isWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
              Build Arcium privacy intent
            </Button>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Native settlement requires the next privacy MXE/program deployment. Provider routes are stored as adapter-ready commitments so the wallet can plug in API execution without changing the UX.
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
              <p className="mt-1 text-xs text-muted-foreground">Create a private intent to produce the first Arcium-ready receipt.</p>
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
                        {PROVIDER_LABEL[receipt.provider]} · {disclosureLabel(receipt.disclosureMode)} · {receipt.minConfirmations} confirmation{receipt.minConfirmations === 1 ? "" : "s"}
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
