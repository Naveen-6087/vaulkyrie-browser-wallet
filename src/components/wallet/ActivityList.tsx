import { ArrowUpRight, ArrowDownLeft, Repeat, ImageIcon, ExternalLink } from "lucide-react";
import type { Transaction } from "@/types";
import { shortenAddress, formatSol, formatTokenAmount } from "@/lib/utils";
import { useWalletStore } from "@/store/walletStore";

interface ActivityListProps {
  transactions: Transaction[];
}

const typeConfig = {
  send: { icon: ArrowUpRight, label: "Sent", color: "text-destructive" },
  receive: { icon: ArrowDownLeft, label: "Received", color: "text-success" },
  swap: { icon: Repeat, label: "Swapped", color: "text-primary" },
  nft: { icon: ImageIcon, label: "NFT", color: "text-info" },
} as const;

function timeAgo(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "pending";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ActivityList({ transactions }: ActivityListProps) {
  const { network } = useWalletStore();

  if (transactions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
          <ArrowUpRight className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">No activity yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Your transactions will appear here
        </p>
      </div>
    );
  }

  const explorerBase = `https://explorer.solana.com/tx`;

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1 mb-2">
        Recent activity
      </h3>
      {transactions.map((tx) => {
        const config = typeConfig[tx.type];
        const Icon = config.icon;
        const isSend = tx.type === "send";
        const explorerUrl = `${explorerBase}/${tx.signature}?cluster=${network}`;
        const amount = Number.isFinite(tx.amount) ? tx.amount : 0;

        return (
          <a
            key={tx.signature}
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 w-full p-3 rounded-xl hover:bg-accent/50 transition-colors cursor-pointer group"
          >
            <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
              <Icon className={`h-4 w-4 ${config.color}`} />
            </div>
            <div className="flex-1 min-w-0 text-left">
              <div className="flex items-center gap-1">
                <p className="text-sm font-medium">{config.label}</p>
                <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <p className="text-xs text-muted-foreground font-mono">
                {isSend && tx.to
                  ? `to ${shortenAddress(tx.to)}`
                  : !isSend && tx.from
                    ? `from ${shortenAddress(tx.from)}`
                    : shortenAddress(tx.signature, 6)}
              </p>
            </div>
            <div className="text-right">
              <p
                className={`text-sm font-medium font-mono ${isSend ? "text-destructive" : "text-success"}`}
              >
                {isSend ? "−" : "+"}
                {tx.token === "SOL" || !tx.token ? formatSol(amount) : formatTokenAmount(amount, 6)} {tx.token ?? "SOL"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {timeAgo(tx.timestamp)}
              </p>
            </div>
          </a>
        );
      })}
    </div>
  );
}
