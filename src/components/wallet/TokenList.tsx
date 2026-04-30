import { useState } from "react";
import { formatTokenAmount, formatUsd } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import type { Token } from "@/types";

interface TokenListProps {
  tokens: Token[];
}

function TokenIcon({ symbol, icon }: { symbol: string; icon?: string }) {
  const [failed, setFailed] = useState(false);
  const hue = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;

  if (icon && !failed) {
    return (
      <img
        src={icon}
        alt={symbol}
        className="h-8 w-8 rounded-full object-cover"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className="h-8 w-8 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
      style={{
        background: `linear-gradient(135deg, oklch(0.60 0.15 ${hue}), oklch(0.45 0.12 ${hue + 30}))`,
      }}
    >
      {symbol.slice(0, 2)}
    </div>
  );
}

export function TokenList({ tokens }: TokenListProps) {
  if (tokens.length === 0) {
    return (
      <Card className="p-6 text-center">
        <p className="text-sm text-muted-foreground">No tokens found</p>
        <p className="text-xs text-muted-foreground mt-1">
          Receive SOL to get started
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1 mb-2">
        Tokens
      </h3>
      {tokens.map((token) => {
        const change = Number.isFinite(token.change24h) ? token.change24h ?? 0 : 0;
        const isPositive = change >= 0;
        return (
            <button
              key={token.mint ?? token.symbol}
            className="flex items-center gap-3 w-full p-3 rounded-xl hover:bg-accent/50 transition-colors cursor-pointer"
          >
            <TokenIcon symbol={token.symbol} icon={token.icon} />
            <div className="flex-1 min-w-0 text-left">
              <p className="text-sm font-medium">{token.symbol}</p>
              <p className="text-xs text-muted-foreground">{token.name}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-medium font-mono">
                {formatTokenAmount(token.balance ?? 0)}
              </p>
              <div className="flex items-center gap-1.5 justify-end">
                <span className="text-xs text-muted-foreground">
                  {formatUsd(token.usdValue ?? 0)}
                </span>
                <span
                  className={`text-[10px] font-medium ${isPositive ? "text-success" : "text-destructive"}`}
                >
                  {isPositive ? "↑" : "↓"}
                  {Math.abs(change).toFixed(1)}%
                </span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
