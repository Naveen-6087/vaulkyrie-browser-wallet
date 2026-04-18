import { useState, useEffect, useCallback } from "react";
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
import type { WalletView } from "@/types";
import type { PolicyConfigAccount, PolicyEvaluationAccount } from "@/sdk/types";

interface PolicyViewProps {
  onNavigate: (view: WalletView) => void;
}

type PolicyPhase = "dashboard" | "init-config" | "open-eval" | "submitting" | "success" | "error";

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

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return buf;
}

export function PolicyView({ onNavigate }: PolicyViewProps) {
  const { activeAccount, network } = useWalletStore();
  const [config, setConfig] = useState<PolicyConfigAccount | null>(null);
  const [evaluations, setEvaluations] = useState<
    { address: PublicKey; account: PolicyEvaluationAccount }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // UI state
  const [phase, setPhase] = useState<PolicyPhase>("dashboard");
  const [actionMsg, setActionMsg] = useState("");
  const [txSignature, setTxSignature] = useState("");
  const [abortingEval, setAbortingEval] = useState<string | null>(null);

  // Init config form
  const [initVersion, setInitVersion] = useState("1");

  // Open evaluation form
  const [evalExpirySlots, setEvalExpirySlots] = useState("200");

  const getConnection = useCallback(() => {
    const rpcUrl = NETWORKS[network]?.rpcUrl;
    if (!rpcUrl) throw new Error("No RPC URL for network");
    return new Connection(rpcUrl, "confirmed");
  }, [network]);

  const fetchPolicyData = useCallback(async () => {
    if (!activeAccount?.publicKey) return;

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
  }, [activeAccount?.publicKey, network, getConnection]);

  useEffect(() => {
    fetchPolicyData();
  }, [fetchPolicyData]);

  // ── Initialize Policy Config ────────────────────────────────────────

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

      // Include rent funding for the config account
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

  // ── Open Policy Evaluation ──────────────────────────────────────────

  const handleOpenEvaluation = async () => {
    if (!activeAccount?.publicKey || !config) return;
    setPhase("submitting");
    setActionMsg("Building evaluation request...");

    try {
      const authority = new PublicKey(activeAccount.publicKey);
      const [configPda] = findPolicyConfigPda(authority);
      const connection = getConnection();

      // Generate random action hash and encrypted input commitment
      const actionHash = randomBytes(32);
      const encryptedInput = randomBytes(32);
      const nonce = config.nextRequestNonce;
      const currentSlot = await connection.getSlot();
      const expirySlot = BigInt(currentSlot) + BigInt(evalExpirySlots || "200");

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

      // Fund the evaluation account
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

  // ── Abort Evaluation ────────────────────────────────────────────────

  const handleAbortEvaluation = async (evalAddress: PublicKey) => {
    if (!activeAccount?.publicKey) return;
    setAbortingEval(evalAddress.toBase58());

    try {
      const authority = new PublicKey(activeAccount.publicKey);
      const connection = getConnection();

      const ix = createAbortPolicyEvaluationInstruction(
        evalAddress,
        authority,
        1, // reason code: manual abort
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

  // ── Success / Error overlay ─────────────────────────────────────────

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
        <h3 className="text-lg font-semibold">Transaction Failed</h3>
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
        <p className="text-sm text-muted-foreground">{actionMsg}</p>
      </div>
    );
  }

  // ── Init Config Form ────────────────────────────────────────────────

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
          <h2 className="text-lg font-semibold flex-1 text-center mr-8">Initialize Policy</h2>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Policy Version</label>
              <Input
                type="number"
                value={initVersion}
                onChange={(e) => setInitVersion(e.target.value)}
                placeholder="1"
                min="1"
              />
            </div>

            <div className="space-y-2 text-[10px] text-muted-foreground">
              <div className="flex justify-between">
                <span>Core Program</span>
                <span className="font-mono">{VAULKYRIE_CORE_PROGRAM_ID.toBase58().slice(0, 16)}…</span>
              </div>
              <div className="flex justify-between">
                <span>MXE Program</span>
                <span className="font-mono">{VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBase58().slice(0, 16)}…</span>
              </div>
              <div className="flex justify-between">
                <span>Authority</span>
                <span className="font-mono">{activeAccount?.publicKey?.slice(0, 16)}…</span>
              </div>
            </div>

            <Button onClick={handleInitConfig} className="w-full">
              <Shield className="h-4 w-4 mr-2" />
              Initialize Policy Config
            </Button>
          </CardContent>
        </Card>

        <div className="bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
          <p className="font-medium text-foreground/70 mb-1">What is this?</p>
          <p>
            Initializes the on-chain policy configuration PDA for your vault. This stores
            program references and tracks the policy version and nonce counter.
            Required before creating any policy evaluations.
          </p>
        </div>
      </div>
    );
  }

  // ── Open Evaluation Form ────────────────────────────────────────────

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
          <h2 className="text-lg font-semibold flex-1 text-center mr-8">New Evaluation</h2>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Expiry (slots from now)</label>
              <Input
                type="number"
                value={evalExpirySlots}
                onChange={(e) => setEvalExpirySlots(e.target.value)}
                placeholder="200"
                min="10"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                ≈ {Math.round(Number(evalExpirySlots || 0) * 0.4)}s at ~400ms/slot
              </p>
            </div>

            <div className="space-y-2 text-[10px] text-muted-foreground">
              <div className="flex justify-between">
                <span>Policy Version</span>
                <span className="font-mono">{config?.policyVersion.toString() ?? "?"}</span>
              </div>
              <div className="flex justify-between">
                <span>Nonce</span>
                <span className="font-mono">{config?.nextRequestNonce.toString() ?? "?"}</span>
              </div>
              <div className="flex justify-between">
                <span>Action Hash</span>
                <span className="font-mono text-amber-400">random (auto)</span>
              </div>
            </div>

            <Button onClick={handleOpenEvaluation} className="w-full">
              <Plus className="h-4 w-4 mr-2" />
              Open Policy Evaluation
            </Button>
          </CardContent>
        </Card>

        <div className="bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
          <p className="font-medium text-foreground/70 mb-1">What is this?</p>
          <p>
            Opens a new policy evaluation request on-chain. In production, the action hash
            would bind to a specific spend or admin action. For testing, a random hash is
            generated. The evaluation can later be finalized (approved), aborted, or queued
            for Arcium MXE computation.
          </p>
        </div>
      </div>
    );
  }

  // ── Main Dashboard ──────────────────────────────────────────────────

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

      {/* Policy Config Status */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-muted-foreground">Policy Configuration</span>
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
                <span className="text-muted-foreground">Policy Version</span>
                <span className="font-mono">{config.policyVersion.toString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Next Nonce</span>
                <span className="font-mono">{config.nextRequestNonce.toString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">MXE Program</span>
                <span className="font-mono text-[10px] truncate max-w-[140px]">
                  {VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBase58().slice(0, 12)}…
                </span>
              </div>
            </div>
          ) : (
            <div className="text-center py-4">
              <ShieldAlert className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm text-muted-foreground">No policy config initialized</p>
              <Button
                onClick={() => setPhase("init-config")}
                variant="outline"
                size="sm"
                className="mt-3"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Initialize Policy
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Buttons (when config exists) */}
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

      {/* Evaluations List */}
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
                ? "Create a new evaluation to test the policy engine flow"
                : "Initialize the policy config first, then create evaluations"}
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
                  <span>Action Hash</span>
                  <span className="font-mono text-right">{shortenHash(ev.account.actionHash)}</span>
                  <span>Policy Ver.</span>
                  <span className="font-mono text-right">{ev.account.policyVersion.toString()}</span>
                  <span>Nonce</span>
                  <span className="font-mono text-right">{ev.account.requestNonce.toString()}</span>
                  <span>Expiry Slot</span>
                  <span className="font-mono text-right">{ev.account.expirySlot.toString()}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Info footer */}
      <div className="mt-auto bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
        <p className="font-medium text-foreground/70 mb-1">About Vaulkyrie Policy Engine</p>
        <p>
          The Arcium MXE evaluates spending policies privately. Sensitive threshold and risk
          parameters stay encrypted — only approval/denial results are published on-chain.
          Initialize a policy config, then create evaluations for pending actions.
        </p>
      </div>
    </div>
  );
}
