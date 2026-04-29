import { ArrowUpRight, ArrowDownLeft, Repeat, ImageIcon, ExternalLink, ShieldCheck } from "lucide-react";
import type { SpendOrchestrationActivity, Transaction } from "@/types";
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

function shortenHex(value: string, prefix: number = 10, suffix: number = 8): string {
  if (value.length <= prefix + suffix + 3) return value;
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

function transactionExplorerUrl(signature: string, network: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${network}`;
}

function accountExplorerUrl(address: string, network: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=${network}`;
}

type ActivityItem =
  | { kind: "orchestration"; timestamp: number; entry: SpendOrchestrationActivity; tx?: Transaction }
  | { kind: "transaction"; timestamp: number; tx: Transaction };

export function ActivityList({ transactions }: ActivityListProps) {
  const { network, activeAccount, getOrchestrationHistory } = useWalletStore();
  const orchestrationHistory = activeAccount
    ? getOrchestrationHistory(activeAccount.publicKey)
    : [];
  const transactionsBySignature = new Map(transactions.map((transaction) => [transaction.signature, transaction]));
  const orchestrationSignatures = new Set(orchestrationHistory.map((entry) => entry.signature));
  const items: ActivityItem[] = [
    ...orchestrationHistory.map((entry) => ({
      kind: "orchestration" as const,
      timestamp: entry.timestamp,
      entry,
      tx: transactionsBySignature.get(entry.signature),
    })),
    ...transactions
      .filter((transaction) => !orchestrationSignatures.has(transaction.signature))
      .map((transaction) => ({
        kind: "transaction" as const,
        timestamp: transaction.timestamp,
        tx: transaction,
      })),
  ].sort((left, right) => right.timestamp - left.timestamp);

  if (items.length === 0) {
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

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1 mb-2">
        Recent activity
      </h3>
      {items.map((item) => {
        if (item.kind === "orchestration") {
          const tx = item.tx;
          const amount = Number.isFinite(item.entry.amount) ? item.entry.amount : 0;
          const status = tx?.status ?? "pending";
          const txUrl = transactionExplorerUrl(item.entry.signature, item.entry.network);
          const orchestrationUrl = accountExplorerUrl(item.entry.orchestrationAddress, item.entry.network);

          return (
            <div
              key={item.entry.id}
              className="rounded-2xl border border-border bg-card/60 p-3 space-y-3"
            >
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">Orchestrated send</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                      status === "failed"
                        ? "bg-destructive/10 text-destructive"
                        : status === "pending"
                          ? "bg-primary/10 text-primary"
                          : "bg-emerald-500/10 text-emerald-400"
                    }`}>
                      {status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {amount} {item.entry.token} to {shortenAddress(item.entry.recipient, 6)}
                  </p>
                </div>
                <div className="text-right text-[10px] text-muted-foreground">
                  {timeAgo(item.entry.timestamp)}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-lg border border-border/70 bg-background/50 px-2.5 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Action hash</p>
                  <p className="mt-1 font-mono break-all">{shortenHex(item.entry.actionHash)}</p>
                </div>
                <div className="rounded-lg border border-border/70 bg-background/50 px-2.5 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Orchestration</p>
                  <p className="mt-1 font-mono break-all">{shortenAddress(item.entry.orchestrationAddress, 6)}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-3 text-[11px]">
                <a
                  href={txUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Transaction
                  <ExternalLink className="h-3 w-3" />
                </a>
                <a
                  href={orchestrationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Orchestration PDA
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          );
        }

        const tx = item.tx;
        const config = typeConfig[tx.type];
        const Icon = config.icon;
        const isSend = tx.type === "send";
        const explorerUrl = transactionExplorerUrl(tx.signature, network);
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
