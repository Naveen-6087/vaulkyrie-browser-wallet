import { BalanceCard } from "@/components/wallet/BalanceCard";
import { CollectiblesGrid } from "@/components/wallet/CollectiblesGrid";
import { TokenList } from "@/components/wallet/TokenList";
import { ActivityList } from "@/components/wallet/ActivityList";
import { useWalletData } from "@/hooks/useWalletData";
import { RefreshCw, WifiOff } from "lucide-react";
import type { WalletView } from "@/types";

interface DashboardProps {
  onNavigate: (view: WalletView) => void;
}

export function Dashboard({ onNavigate }: DashboardProps) {
  const {
    tokens,
    collectibles,
    transactions,
    isLoading,
    error,
    refreshAll,
  } = useWalletData();

  const totalUsd = tokens.reduce((sum, t) => sum + (t.usdValue ?? 0), 0);
  const solToken = tokens.find((t) => t.symbol === "SOL");
  const totalSol = solToken?.balance ?? 0;
  const change24h = solToken?.change24h ?? 0;

  const hasData = tokens.length > 0;

  return (
    <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto">
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 text-destructive text-xs">
          <WifiOff className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            onClick={refreshAll}
            className="text-xs underline hover:no-underline cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {isLoading && !hasData && (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-5 w-5 animate-spin text-primary mr-2" />
          <span className="text-sm text-muted-foreground">
            Fetching from Solana {/* network name shown in header */}…
          </span>
        </div>
      )}

      <BalanceCard
        totalUsd={totalUsd}
        totalSol={totalSol}
        change24h={change24h}
        onNavigate={onNavigate}
      />

      {isLoading && hasData && (
        <div className="flex justify-center">
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>
      )}

      <TokenList tokens={tokens} />
      <CollectiblesGrid
        collectibles={collectibles}
        isLoading={isLoading}
        onNavigate={onNavigate}
      />
      <ActivityList transactions={transactions} />
    </div>
  );
}
