import { useState, useEffect, useCallback } from "react";
import { PublicKey, Connection } from "@solana/web3.js";
import { Shield, ShieldCheck, ShieldAlert, ShieldX, Loader2, RefreshCw, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useWalletStore } from "@/store/walletStore";
import { PolicyMxeClient } from "@/sdk/policyClient";
import { VAULKYRIE_POLICY_MXE_PROGRAM_ID, PolicyEvaluationStatus } from "@/sdk/constants";
import { NETWORKS } from "@/lib/constants";
import type { WalletView } from "@/types";
import type { PolicyConfigAccount, PolicyEvaluationAccount } from "@/sdk/types";

interface PolicyViewProps {
  onNavigate: (view: WalletView) => void;
}

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

export function PolicyView({ onNavigate }: PolicyViewProps) {
  const { activeAccount, network } = useWalletStore();
  const [config, setConfig] = useState<PolicyConfigAccount | null>(null);
  const [evaluations, setEvaluations] = useState<
    { address: PublicKey; account: PolicyEvaluationAccount }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchPolicyData = useCallback(async () => {
    if (!activeAccount?.publicKey) return;

    setLoading(true);
    setError("");

    try {
      const rpcUrl = NETWORKS[network]?.rpcUrl;
      if (!rpcUrl) throw new Error("No RPC URL for network");

      const connection = new Connection(rpcUrl, "confirmed");
      const client = new PolicyMxeClient(connection);

      // Try to find policy config for the active account authority
      const pubkey = new PublicKey(activeAccount.publicKey);
      const configResult = await client.getPolicyConfig(pubkey);

      if (configResult) {
        setConfig(configResult.account);
        // Fetch evaluations for this vault
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
  }, [activeAccount?.publicKey, network]);

  useEffect(() => {
    fetchPolicyData();
  }, [fetchPolicyData]);

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
              <p className="text-sm text-muted-foreground">No policy config found</p>
              <p className="text-[10px] text-muted-foreground/70 mt-1">
                Policy engine will be configured when the vault is initialized on-chain
              </p>
            </div>
          )}
        </CardContent>
      </Card>

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
              Policy evaluations appear here when transactions require approval
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
        </p>
      </div>
    </div>
  );
}
