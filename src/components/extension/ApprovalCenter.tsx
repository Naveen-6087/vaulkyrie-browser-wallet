import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Clock, Shield, Trash2, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  listPendingExtensionApprovals,
  listApprovedOrigins,
  revokeOrigin,
  type ApprovedOriginRecord,
  resolveExtensionApproval,
  type ExtensionApprovalRequest,
} from "@/extension/approvalStorage";
import type { WalletView } from "@/types";
import { useWalletStore } from "@/store/walletStore";

interface ApprovalCenterProps {
  onNavigate: (view: WalletView) => void;
}

function formatMethodLabel(method: ExtensionApprovalRequest["method"]): string {
  switch (method) {
    case "connect":
      return "Connect site";
    case "signTransaction":
      return "Sign transaction";
    case "signMessage":
      return "Sign message";
    default:
      return method;
  }
}

export function ApprovalCenter({ onNavigate }: ApprovalCenterProps) {
  const activeAccount = useWalletStore((state) => state.activeAccount);
  const [approvals, setApprovals] = useState<ExtensionApprovalRequest[]>([]);
  const [approvedOrigins, setApprovedOrigins] = useState<ApprovedOriginRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const activePublicKey = activeAccount?.publicKey ?? null;

  const loadApprovals = useCallback(async () => {
    setLoading(true);
    try {
      const [nextApprovals, nextApprovedOrigins] = await Promise.all([
        listPendingExtensionApprovals(),
        listApprovedOrigins(activePublicKey),
      ]);
      setApprovals(nextApprovals);
      setApprovedOrigins(nextApprovedOrigins);
    } finally {
      setLoading(false);
    }
  }, [activePublicKey]);

  useEffect(() => {
    void loadApprovals();
    const interval = window.setInterval(() => {
      void loadApprovals();
    }, 1500);
    return () => window.clearInterval(interval);
  }, [loadApprovals]);

  const handleResolve = async (
    id: string,
    status: "approved" | "rejected",
  ) => {
    setActingOn(id);
    try {
      await resolveExtensionApproval(id, status);
      await loadApprovals();
    } finally {
      setActingOn(null);
    }
  };

  const handleRevokeOrigin = async (origin: string) => {
    setActingOn(origin);
    try {
      await revokeOrigin(origin, activePublicKey);
      await loadApprovals();
    } finally {
      setActingOn(null);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto">
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => onNavigate("dashboard")}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold flex-1 text-center mr-8">
          DApp Approvals
        </h2>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="rounded-xl border border-primary/15 bg-primary/5 px-3 py-3 text-[11px] text-muted-foreground">
            Requests from websites show up here before Vaulkyrie connects or signs on their behalf.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4 space-y-3">
          <div>
            <p className="text-sm font-medium">Connected sites</p>
            <p className="text-[11px] text-muted-foreground">
              Approvals are scoped to the active vault and can be revoked at any time.
            </p>
          </div>

          {approvedOrigins.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
              No approved sites for this vault yet.
            </div>
          ) : (
            <div className="space-y-2">
              {approvedOrigins.map((record) => (
                <div
                  key={`${record.origin}-${record.accountPublicKey ?? "none"}`}
                  className="flex items-center gap-3 rounded-xl border border-border px-3 py-3"
                >
                  <Shield className="h-4 w-4 text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium">{record.origin}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Last used {record.lastUsedAt ? new Date(record.lastUsedAt).toLocaleString() : "recently"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRevokeOrigin(record.origin)}
                    disabled={actingOn === record.origin}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Loading pending requests…
          </CardContent>
        </Card>
      ) : approvals.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Shield className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
            <p className="text-sm text-muted-foreground">No pending dApp approvals</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {approvals.map((approval) => (
            <Card key={approval.id}>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-primary" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{formatMethodLabel(approval.method)}</p>
                    <p className="text-[11px] text-muted-foreground">{approval.origin}</p>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {new Date(approval.createdAt).toLocaleTimeString()}
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-background/60 px-3 py-2 text-[11px] text-muted-foreground">
                  {approval.summary}
                </div>

                {approval.details && (
                  <div className="space-y-3 rounded-lg border border-border bg-background/40 px-3 py-3">
                    {approval.details.title && (
                      <p className="text-[11px] font-medium text-foreground">{approval.details.title}</p>
                    )}

                    {approval.details.fields.length > 0 && (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {approval.details.fields.map((field) => (
                          <div
                            key={`${approval.id}-${field.label}`}
                            className="rounded-md border border-border/70 bg-background/60 px-2.5 py-2"
                          >
                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              {field.label}
                            </p>
                            <p
                              className={`mt-1 text-[11px] ${
                                field.monospace ? "font-mono break-all" : ""
                              } ${
                                field.tone === "warning"
                                  ? "text-amber-300"
                                  : field.tone === "muted"
                                    ? "text-muted-foreground"
                                    : "text-foreground"
                              }`}
                            >
                              {field.value}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}

                    {approval.details.warnings && approval.details.warnings.length > 0 && (
                      <div className="space-y-2">
                        {approval.details.warnings.map((warning) => (
                          <div
                            key={`${approval.id}-${warning}`}
                            className="flex items-start gap-2 rounded-md border border-amber-400/20 bg-amber-400/5 px-2.5 py-2 text-[11px] text-amber-100"
                          >
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                            <span>{warning}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    onClick={() => void handleResolve(approval.id, "approved")}
                    disabled={actingOn === approval.id}
                  >
                    <Check className="h-4 w-4 mr-1" />
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => void handleResolve(approval.id, "rejected")}
                    disabled={actingOn === approval.id}
                  >
                    <XCircle className="h-4 w-4 mr-1" />
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
