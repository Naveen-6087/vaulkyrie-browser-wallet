import { useCallback, useEffect, useState } from "react";
import { Check, Clock, Shield, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  listPendingExtensionApprovals,
  resolveExtensionApproval,
  type ExtensionApprovalRequest,
} from "@/extension/approvalStorage";
import type { WalletView } from "@/types";

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
  const [approvals, setApprovals] = useState<ExtensionApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | null>(null);

  const loadApprovals = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listPendingExtensionApprovals();
      setApprovals(next);
    } finally {
      setLoading(false);
    }
  }, []);

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
