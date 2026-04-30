import { ArrowUpRight, ArrowDownLeft, ArrowLeftRight, RadioTower, Shield } from "lucide-react";
import { formatUsd } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { WalletView } from "@/types";

interface BalanceCardProps {
  totalUsd: number;
  totalSol: number;
  change24h: number;
  onNavigate: (view: WalletView) => void;
}

export function BalanceCard({
  totalUsd,
  totalSol,
  change24h,
  onNavigate,
}: BalanceCardProps) {
  const isPositive = change24h >= 0;

  return (
    <Card className="border-0 bg-gradient-to-br from-card to-card/60 overflow-hidden">
      <div className="p-5">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">
          Total balance
        </p>
        <h2 className="text-3xl font-bold tracking-tight font-mono">
          {formatUsd(totalUsd)}
        </h2>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-sm text-muted-foreground font-mono">
            {totalSol.toFixed(4)} SOL
          </span>
          <span
            className={`text-xs font-medium ${isPositive ? "text-success" : "text-destructive"}`}
          >
            {isPositive ? "+" : ""}
            {change24h.toFixed(2)}%
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-5">
          <Button
            variant="default"
            size="sm"
            className="gap-1.5"
            onClick={() => onNavigate("send")}
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            Send
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={() => onNavigate("receive")}
          >
            <ArrowDownLeft className="h-3.5 w-3.5" />
            Receive
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={() => onNavigate("swap")}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            Swap
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={() => onNavigate("privacy")}
          >
            <Shield className="h-3.5 w-3.5" />
            Privacy
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={() => onNavigate("activity")}
          >
            <RadioTower className="h-3.5 w-3.5" />
            Activity
          </Button>
        </div>
      </div>
    </Card>
  );
}
