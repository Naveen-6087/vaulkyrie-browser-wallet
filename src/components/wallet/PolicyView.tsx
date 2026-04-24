import { useState, useEffect, useCallback, useMemo } from "react";
import { PublicKey, Connection, Transaction, SystemProgram } from "@solana/web3.js";
import {
  Shield, ShieldCheck, ShieldAlert, ShieldX,
  Loader2, RefreshCw, Clock, Plus, XCircle, AlertCircle, Check, ExternalLink,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWalletStore } from "@/store/walletStore";
import { PolicyMxeClient, findPolicyConfigPda, findPolicyEvaluationPda } from "@/sdk/policyClient";
import {
  VAULKYRIE_POLICY_MXE_PROGRAM_ID,
  VAULKYRIE_CORE_PROGRAM_ID,
  PolicyEvaluationStatus,
  ACCOUNT_SIZE,
} from "@/sdk/constants";
import {
  createInitPolicyConfigInstruction,
  createOpenPolicyEvaluationInstruction,
  createAbortPolicyEvaluationInstruction,
} from "@/sdk/policyInstructions";
import { signAndSendTransaction } from "@/services/frost/signTransaction";
import { NETWORKS } from "@/lib/constants";
import type { WalletView, PolicyProfile } from "@/types";
import type { PolicyConfigAccount, PolicyEvaluationAccount } from "@/sdk/types";

interface PolicyViewProps {
  onNavigate: (view: WalletView) => void;
}

type PolicyPhase =
  | "dashboard"
  | "init-config"
  | "create-profile"
  | "open-eval"
  | "submitting"
  | "success"
  | "error";

function statusIcon(status: PolicyEvaluationStatus) {
  switch (status) {
    case PolicyEvaluationStatus.Pending:
      return <Clock className="h-4 w-4 text-amber-400" />;
    case PolicyEvaluationStatus.Finalized:
      return <ShieldCheck className="h-4 w-4 text-emerald-400" />;
    case PolicyEvaluationStatus.Aborted:
      return <ShieldX className="h-4 w-4 text-red-400" />;
    case PolicyEvaluationStatus.ComputationQueued:
      return <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />;
    default:
      return <ShieldAlert className="h-4 w-4 text-muted-foreground" />;
  }
}

function statusColor(status: PolicyEvaluationStatus): string {
  switch (status) {
    case PolicyEvaluationStatus.Pending:
      return "text-amber-400";
    case PolicyEvaluationStatus.Finalized:
      return "text-emerald-400";
    case PolicyEvaluationStatus.Aborted:
      return "text-red-400";
    case PolicyEvaluationStatus.ComputationQueued:
      return "text-blue-400";
    default:
      return "text-muted-foreground";
  }
}

function shortenHash(hash: Uint8Array): string {
  const hex = Array.from(hash.slice(0, 6))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex}…`;
}

async function digestString(value: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(digest);
}

function formatApprovalMode(mode: PolicyProfile["approvalMode"]): string {
  switch (mode) {
    case "allow":
      return "Auto-allow";
    case "review":
      return "Manual review";
    case "block":
      return "Block";
    default:
      return mode;
  }
}

function normalizeRecipients(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function PolicyView({ onNavigate }: PolicyViewProps) {
  const {
    activeAccount,
    network,
    getPolicyProfiles,
    upsertPolicyProfile,
    deletePolicyProfile,
  } = useWalletStore();
  const [config, setConfig] = useState<PolicyConfigAccount | null>(null);
  const [evaluations, setEvaluations] = useState<
    { address: PublicKey; account: PolicyEvaluationAccount }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [phase, setPhase] = useState<PolicyPhase>("dashboard");
  const [actionMsg, setActionMsg] = useState("");
  const [txSignature, setTxSignature] = useState("");
  const [abortingEval, setAbortingEval] = useState<string | null>(null);

  const [initVersion, setInitVersion] = useState("1");

  const [profileName, setProfileName] = useState("");
  const [profileActionType, setProfileActionType] = useState<PolicyProfile["actionType"]>("send");
  const [profileApprovalMode, setProfileApprovalMode] = useState<PolicyProfile["approvalMode"]>("review");
  const [profileTokenSymbol, setProfileTokenSymbol] = useState("SOL");
  const [profileMaxAmount, setProfileMaxAmount] = useState("");
  const [profileRecipients, setProfileRecipients] = useState("");
  const [profileNotes, setProfileNotes] = useState("");

  const [evalExpirySlots, setEvalExpirySlots] = useState("200");
  const [evalActionType, setEvalActionType] = useState<PolicyProfile["actionType"]>("send");
  const [evalRecipient, setEvalRecipient] = useState("");
  const [evalAmount, setEvalAmount] = useState("");
  const [evalToken, setEvalToken] = useState("SOL");
  const [selectedProfileId, setSelectedProfileId] = useState("");

  const savedProfiles = useMemo(
    () => (activeAccount?.publicKey ? getPolicyProfiles(activeAccount.publicKey) : []),
    [activeAccount?.publicKey, getPolicyProfiles],
  );
  const selectedProfile = savedProfiles.find((profile) => profile.id === selectedProfileId) ?? null;

  useEffect(() => {
    if (!savedProfiles.length) {
      if (selectedProfileId) setSelectedProfileId("");
      return;
    }
    if (!selectedProfileId || !savedProfiles.some((profile) => profile.id === selectedProfileId)) {
      setSelectedProfileId(savedProfiles[0].id);
    }
  }, [savedProfiles, selectedProfileId]);

  const getConnection = useCallback(() => {
    const rpcUrl = NETWORKS[network]?.rpcUrl;
    if (!rpcUrl) throw new Error("No RPC URL for network");
    return new Connection(rpcUrl, "confirmed");
  }, [network]);

  const fetchPolicyData = useCallback(async () => {
    if (!activeAccount?.publicKey) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");

    try {
      const connection = getConnection();
      const client = new PolicyMxeClient(connection);
      const pubkey = new PublicKey(activeAccount.publicKey);
      const configResult = await client.getPolicyConfig(pubkey);

      if (configResult) {
        setConfig(configResult.account);
        const evals = await client.getEvaluationsForVault(pubkey);
        setEvaluations(evals);
      } else {
        setConfig(null);
        setEvaluations([]);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to fetch policy data");
    } finally {
      setLoading(false);
    }
  }, [activeAccount?.publicKey, getConnection]);

  useEffect(() => {
    fetchPolicyData();
  }, [fetchPolicyData]);

  const resetProfileForm = useCallback(() => {
    setProfileName("");
    setProfileActionType("send");
    setProfileApprovalMode("review");
    setProfileTokenSymbol("SOL");
    setProfileMaxAmount("");
    setProfileRecipients("");
    setProfileNotes("");
  }, []);

  const handleSaveProfile = () => {
    if (!activeAccount?.publicKey) return;
    const trimmedName = profileName.trim();
    if (!trimmedName) {
      setError("Give this policy a name first.");
      setPhase("error");
      return;
    }

    const now = Date.now();
    const maxAmountValue = profileMaxAmount.trim() ? Number(profileMaxAmount) : null;
    if (maxAmountValue !== null && Number.isNaN(maxAmountValue)) {
      setError("Max amount must be a valid number.");
      setPhase("error");
      return;
    }

    upsertPolicyProfile(activeAccount.publicKey, {
      id: crypto.randomUUID(),
      name: trimmedName,
      actionType: profileActionType,
      approvalMode: profileApprovalMode,
      tokenSymbol: profileTokenSymbol.trim().toUpperCase() || "SOL",
      maxAmount: maxAmountValue,
      allowedRecipients: normalizeRecipients(profileRecipients),
      notes: profileNotes.trim(),
      createdAt: now,
      updatedAt: now,
    });

    resetProfileForm();
    setPhase("dashboard");
  };

  const handleDeleteProfile = (profileId: string) => {
    if (!activeAccount?.publicKey) return;
    deletePolicyProfile(activeAccount.publicKey, profileId);
  };

  const handleInitConfig = async () => {
    if (!activeAccount?.publicKey) return;
    setPhase("submitting");
    setActionMsg("Deriving policy config PDA...");

    try {
      const authority = new PublicKey(activeAccount.publicKey);
      const [configPda, bump] = findPolicyConfigPda(authority);
      const connection = getConnection();

      setActionMsg("Building init_policy_config transaction...");

      const ix = createInitPolicyConfigInstruction(configPda, authority, {
        coreProgram: VAULKYRIE_CORE_PROGRAM_ID.toBytes(),
        arciumProgram: VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBytes(),
        mxeAccount: VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBytes(),
        policyVersion: BigInt(initVersion || "1"),
        bump,
      });

      const rentLamports = await connection.getMinimumBalanceForRentExemption(
        ACCOUNT_SIZE.PolicyConfigState,
      );
      const fundIx = SystemProgram.createAccount({
        fromPubkey: authority,
        newAccountPubkey: configPda,
        lamports: rentLamports,
        space: ACCOUNT_SIZE.PolicyConfigState,
        programId: VAULKYRIE_POLICY_MXE_PROGRAM_ID,
      });

      const tx = new Transaction().add(fundIx, ix);

      const sig = await signAndSendTransaction(
        connection,
        tx,
        activeAccount.publicKey,
        (msg) => setActionMsg(msg),
      );

      setTxSignature(sig);
      setPhase("success");
      fetchPolicyData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to initialize policy config");
      setPhase("error");
    }
  };

  const handleOpenEvaluation = async () => {
    if (!activeAccount?.publicKey || !config) return;
    setPhase("submitting");
    setActionMsg("Building evaluation request...");

    try {
      const authority = new PublicKey(activeAccount.publicKey);
      if (evalActionType === "send" && evalRecipient.trim()) {
        new PublicKey(evalRecipient.trim());
      }

      const connection = getConnection();
      const [configPda] = findPolicyConfigPda(authority);
      const nonce = config.nextRequestNonce;
      const currentSlot = await connection.getSlot();
      const expirySlot = BigInt(currentSlot) + BigInt(evalExpirySlots || "200");

      const actionPayload = {
        profileId: selectedProfile?.id ?? null,
        profileName: selectedProfile?.name ?? null,
        actionType: evalActionType,
        recipient: evalRecipient.trim(),
        amount: Number(evalAmount || "0"),
        token: evalToken.trim().toUpperCase() || "SOL",
        notes: selectedProfile?.notes ?? "",
      };
      const actionHash = await digestString(JSON.stringify(actionPayload));
      const encryptedInput = await digestString(JSON.stringify({
        policyProfile: selectedProfile,
        actionPayload,
        mode: "wallet-prototype-commitment",
      }));
      const [evalPda] = findPolicyEvaluationPda(configPda, actionHash);

      setActionMsg("Building open_policy_evaluation transaction...");

      const ix = createOpenPolicyEvaluationInstruction(
        configPda,
        evalPda,
        authority,
        {
          vaultId: authority.toBytes(),
          actionHash,
          encryptedInputCommitment: encryptedInput,
          requestNonce: nonce,
          expirySlot,
          computationOffset: 0n,
        },
      );

      const rentLamports = await connection.getMinimumBalanceForRentExemption(
        ACCOUNT_SIZE.PolicyEvaluationState,
      );
      const fundIx = SystemProgram.createAccount({
        fromPubkey: authority,
        newAccountPubkey: evalPda,
        lamports: rentLamports,
        space: ACCOUNT_SIZE.PolicyEvaluationState,
        programId: VAULKYRIE_POLICY_MXE_PROGRAM_ID,
      });

      const tx = new Transaction().add(fundIx, ix);

      const sig = await signAndSendTransaction(
        connection,
        tx,
        activeAccount.publicKey,
        (msg) => setActionMsg(msg),
      );

      setTxSignature(sig);
      setPhase("success");
      fetchPolicyData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open evaluation");
      setPhase("error");
    }
  };

  const handleAbortEvaluation = async (evalAddress: PublicKey) => {
    if (!activeAccount?.publicKey) return;
    setAbortingEval(evalAddress.toBase58());

    try {
      const authority = new PublicKey(activeAccount.publicKey);
      const connection = getConnection();

      const ix = createAbortPolicyEvaluationInstruction(
        evalAddress,
        authority,
        1,
      );

      const tx = new Transaction().add(ix);

      await signAndSendTransaction(
        connection,
        tx,
        activeAccount.publicKey,
      );

      fetchPolicyData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to abort evaluation");
    } finally {
      setAbortingEval(null);
    }
  };

  if (phase === "success") {
    const explorerBase = NETWORKS[network]?.explorerUrl ?? "https://explorer.solana.com";
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-6 flex-1">
        <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
          <Check className="h-8 w-8 text-emerald-400" />
        </div>
        <h3 className="text-lg font-semibold">Transaction Submitted</h3>
        {txSignature && (
          <a
            href={`${explorerBase}/tx/${txSignature}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:underline flex items-center gap-1"
          >
            View on Explorer <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <Button
          onClick={() => { setPhase("dashboard"); setTxSignature(""); }}
          className="mt-4"
        >
          Back to Policy Dashboard
        </Button>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-6 flex-1">
        <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center">
          <AlertCircle className="h-8 w-8 text-red-400" />
        </div>
        <h3 className="text-lg font-semibold">Action Failed</h3>
        <p className="text-sm text-muted-foreground text-center max-w-[280px]">{error}</p>
        <Button
          onClick={() => { setPhase("dashboard"); setError(""); }}
          variant="outline"
          className="mt-4"
        >
          Try Again
        </Button>
      </div>
    );
  }

  if (phase === "submitting") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-6 flex-1">
        <Loader2 className="h-10 w-10 text-primary animate-spin" />
        <p className="text-sm text-muted-foreground text-center max-w-[260px]">{actionMsg}</p>
      </div>
    );
  }

  if (phase === "create-profile") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setPhase("dashboard")}
            className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
          >
            ← Back
          </button>
          <h2 className="text-lg font-semibold flex-1 text-center mr-8">Create Policy Profile</h2>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Policy name</label>
              <Input
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                placeholder="Daily transfers under 1 SOL"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Action type</label>
                <select
                  value={profileActionType}
                  onChange={(event) => setProfileActionType(event.target.value as PolicyProfile["actionType"])}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="send">Send</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Decision</label>
                <select
                  value={profileApprovalMode}
                  onChange={(event) => setProfileApprovalMode(event.target.value as PolicyProfile["approvalMode"])}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="allow">Auto-allow</option>
                  <option value="review">Manual review</option>
                  <option value="block">Block</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Token</label>
                <Input
                  value={profileTokenSymbol}
                  onChange={(event) => setProfileTokenSymbol(event.target.value.toUpperCase())}
                  placeholder="SOL"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Max amount</label>
                <Input
                  type="number"
                  value={profileMaxAmount}
                  onChange={(event) => setProfileMaxAmount(event.target.value)}
                  placeholder="1.0"
                  min="0"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Allowed recipients</label>
              <textarea
                value={profileRecipients}
                onChange={(event) => setProfileRecipients(event.target.value)}
                placeholder="One address per line or comma-separated"
                className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
              <textarea
                value={profileNotes}
                onChange={(event) => setProfileNotes(event.target.value)}
                placeholder="Describe why this rule exists or what it protects."
                className="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <Button onClick={handleSaveProfile} className="w-full">
              <Shield className="h-4 w-4 mr-2" />
              Save policy profile
            </Button>
          </CardContent>
        </Card>

        <div className="bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
          <p className="font-medium text-foreground/70 mb-1">What this saves</p>
          <p>
            Policy profiles live inside the wallet and capture the rule you want reviewers or the
            private Arcium flow to evaluate later. They make the dashboard usable now, even before
            every encrypted MXE path is fully wired into each transaction flow.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "init-config") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setPhase("dashboard")}
            className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
          >
            ← Back
          </button>
          <h2 className="text-lg font-semibold flex-1 text-center mr-8">Initialize Policy Bridge</h2>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Policy version</label>
              <Input
                type="number"
                value={initVersion}
                onChange={(event) => setInitVersion(event.target.value)}
                placeholder="1"
                min="1"
              />
            </div>

            <div className="space-y-2 text-[10px] text-muted-foreground">
              <div className="flex justify-between">
                <span>Core program</span>
                <span className="font-mono">{VAULKYRIE_CORE_PROGRAM_ID.toBase58().slice(0, 16)}…</span>
              </div>
              <div className="flex justify-between">
                <span>MXE program</span>
                <span className="font-mono">{VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBase58().slice(0, 16)}…</span>
              </div>
              <div className="flex justify-between">
                <span>Authority</span>
                <span className="font-mono">{activeAccount?.publicKey?.slice(0, 16)}…</span>
              </div>
            </div>

            <Button onClick={handleInitConfig} className="w-full">
              <Shield className="h-4 w-4 mr-2" />
              Initialize on-chain bridge
            </Button>
          </CardContent>
        </Card>

        <div className="bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
          <p className="font-medium text-foreground/70 mb-1">Advanced / devnet</p>
          <p>
            This initializes the raw policy bridge account used by the Arcium MXE program. It is the
            low-level on-chain setup step, separate from the human-readable policy profiles above.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "open-eval") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setPhase("dashboard")}
            className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
          >
            ← Back
          </button>
          <h2 className="text-lg font-semibold flex-1 text-center mr-8">Open Evaluation</h2>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Policy profile</label>
              <select
                value={selectedProfileId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setSelectedProfileId(nextId);
                  const nextProfile = savedProfiles.find((profile) => profile.id === nextId);
                  if (nextProfile) {
                    setEvalActionType(nextProfile.actionType);
                    setEvalToken(nextProfile.tokenSymbol);
                  }
                }}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">No saved profile</option>
                {savedProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Action type</label>
                <select
                  value={evalActionType}
                  onChange={(event) => setEvalActionType(event.target.value as PolicyProfile["actionType"])}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="send">Send</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Expiry (slots)</label>
                <Input
                  type="number"
                  value={evalExpirySlots}
                  onChange={(event) => setEvalExpirySlots(event.target.value)}
                  placeholder="200"
                  min="10"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Token</label>
                <Input
                  value={evalToken}
                  onChange={(event) => setEvalToken(event.target.value.toUpperCase())}
                  placeholder="SOL"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Amount</label>
                <Input
                  type="number"
                  value={evalAmount}
                  onChange={(event) => setEvalAmount(event.target.value)}
                  placeholder="0.5"
                  min="0"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Recipient / target</label>
              <Input
                value={evalRecipient}
                onChange={(event) => setEvalRecipient(event.target.value)}
                placeholder="Recipient address or admin target"
              />
            </div>

            {selectedProfile && (
              <div className="rounded-xl border border-border bg-background/60 px-3 py-3 text-[11px] text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">{selectedProfile.name}</p>
                <p>{formatApprovalMode(selectedProfile.approvalMode)} · {selectedProfile.actionType} · {selectedProfile.tokenSymbol}</p>
                <p>
                  Max amount: {selectedProfile.maxAmount ?? "No cap"} · Allowed recipients: {selectedProfile.allowedRecipients.length || "Any"}
                </p>
              </div>
            )}

            <Button onClick={handleOpenEvaluation} className="w-full">
              <Plus className="h-4 w-4 mr-2" />
              Open policy evaluation
            </Button>
          </CardContent>
        </Card>

        <div className="bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
          <p className="font-medium text-foreground/70 mb-1">What gets bound on-chain</p>
          <p>
            The wallet hashes the selected action summary and chosen policy profile into the evaluation
            request. That makes the request deterministic and reviewable instead of using a random test hash.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 flex-1">
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => onNavigate("dashboard")}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold flex-1 text-center mr-8 flex items-center justify-center gap-2">
          <Shield className="h-5 w-5" />
          Policy Engine
        </h2>
      </div>

      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-muted-foreground">Policy Profiles</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                resetProfileForm();
                setPhase("create-profile");
              }}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              New Profile
            </Button>
          </div>

          {savedProfiles.length === 0 ? (
            <div className="text-center py-4">
              <ShieldAlert className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm text-muted-foreground">No policy profiles saved yet</p>
              <p className="text-[10px] text-muted-foreground/70 mt-1">
                Create reusable rules for send and admin actions so reviewers know what to approve.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {savedProfiles.map((profile) => (
                <div key={profile.id} className="rounded-xl border border-border bg-background/60 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">{profile.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 ml-auto text-red-400 hover:text-red-300"
                      onClick={() => handleDeleteProfile(profile.id)}
                    >
                      <XCircle className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
                    <span>Action</span>
                    <span className="text-right">{profile.actionType}</span>
                    <span>Decision</span>
                    <span className="text-right">{formatApprovalMode(profile.approvalMode)}</span>
                    <span>Token / cap</span>
                    <span className="text-right">
                      {profile.tokenSymbol} / {profile.maxAmount ?? "No cap"}
                    </span>
                    <span>Recipients</span>
                    <span className="text-right">{profile.allowedRecipients.length || "Any"}</span>
                  </div>
                  {profile.notes && (
                    <p className="text-[10px] text-muted-foreground border-t border-border pt-2">
                      {profile.notes}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-muted-foreground">On-Chain Policy Bridge</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchPolicyData}
              disabled={loading}
              className="h-7 w-7 p-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-4 justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading policy state…</span>
            </div>
          ) : error ? (
            <div className="text-sm text-destructive py-2">{error}</div>
          ) : config ? (
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Status</span>
                <span className="text-emerald-400 font-medium flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  Active
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Policy version</span>
                <span className="font-mono">{config.policyVersion.toString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Next nonce</span>
                <span className="font-mono">{config.nextRequestNonce.toString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">MXE program</span>
                <span className="font-mono text-[10px] truncate max-w-[140px]">
                  {VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBase58().slice(0, 12)}…
                </span>
              </div>
            </div>
          ) : (
            <div className="text-center py-4">
              <ShieldAlert className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm text-muted-foreground">No on-chain bridge initialized</p>
              <Button
                onClick={() => setPhase("init-config")}
                variant="outline"
                size="sm"
                className="mt-3"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Initialize Bridge
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {config && (
        <div className="flex gap-2">
          <Button
            onClick={() => setPhase("open-eval")}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            New Evaluation
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Policy Evaluations</span>
        <span className="text-[10px] text-muted-foreground">
          {evaluations.length} total
        </span>
      </div>

      {evaluations.length === 0 && !loading ? (
        <Card>
          <CardContent className="py-6 text-center">
            <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
            <p className="text-sm text-muted-foreground">No evaluations yet</p>
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              {config
                ? "Create an evaluation from a saved policy profile to exercise the bridge."
                : "Create a policy profile now, then initialize the bridge when you want on-chain evaluations."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2 overflow-y-auto max-h-[320px]">
          {evaluations.map((ev) => (
            <Card key={ev.address.toBase58()}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center gap-2 mb-2">
                  {statusIcon(ev.account.status)}
                  <span className={`text-xs font-medium ${statusColor(ev.account.status)}`}>
                    {PolicyMxeClient.statusLabel(ev.account.status)}
                  </span>
                  {ev.account.reasonCode > 0 && (
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      Code: {ev.account.reasonCode}
                    </span>
                  )}
                  {ev.account.status === PolicyEvaluationStatus.Pending && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleAbortEvaluation(ev.address)}
                      disabled={abortingEval === ev.address.toBase58()}
                      className="h-6 px-2 ml-auto text-red-400 hover:text-red-300"
                    >
                      {abortingEval === ev.address.toBase58() ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <XCircle className="h-3 w-3" />
                      )}
                      <span className="text-[10px] ml-1">Abort</span>
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
                  <span>Action hash</span>
                  <span className="font-mono text-right">{shortenHash(ev.account.actionHash)}</span>
                  <span>Policy ver.</span>
                  <span className="font-mono text-right">{ev.account.policyVersion.toString()}</span>
                  <span>Nonce</span>
                  <span className="font-mono text-right">{ev.account.requestNonce.toString()}</span>
                  <span>Expiry slot</span>
                  <span className="font-mono text-right">{ev.account.expirySlot.toString()}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-auto bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
        <p className="font-medium text-foreground/70 mb-1">How to use this screen</p>
        <p>
          1. Create human-readable policy profiles for common send/admin rules. 2. Initialize the
          on-chain bridge when you want to test the MXE flow. 3. Open evaluations that bind a real
          action summary to the selected policy instead of using anonymous placeholder hashes.
        </p>
      </div>
    </div>
  );
}
