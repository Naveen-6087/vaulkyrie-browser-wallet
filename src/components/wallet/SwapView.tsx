import { useState, useEffect, useRef, useCallback } from "react";
import { ArrowDownUp, Loader2, AlertCircle, ChevronDown, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useWalletStore } from "@/store/walletStore";
import { KNOWN_MINTS, SOL_ICON } from "@/services/solanaRpc";
import type { WalletView, Token } from "@/types";

interface SwapViewProps {
  balance: number;
  onNavigate: (view: WalletView) => void;
}

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { label: string } }[];
}

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Tokens available for swap (SOL + KNOWN_MINTS)
function getSwappableTokens(walletTokens: Token[]): Token[] {
  const solToken: Token = {
    symbol: "SOL",
    name: "Solana",
    balance: 0,
    decimals: 9,
    mint: SOL_MINT,
    icon: SOL_ICON,
  };

  // Merge wallet balances with known mints
  const merged: Token[] = [solToken];
  const seen = new Set(["SOL"]);

  for (const t of walletTokens) {
    if (!seen.has(t.symbol)) {
      merged.push(t);
      seen.add(t.symbol);
    } else if (t.symbol === "SOL") {
      merged[0].balance = t.balance;
    }
  }

  // Add known mints that aren't in the wallet
  for (const [mint, info] of Object.entries(KNOWN_MINTS)) {
    if (mint === SOL_MINT) continue;
    if (!seen.has(info.symbol)) {
      merged.push({
        symbol: info.symbol,
        name: info.name,
        balance: 0,
        decimals: info.decimals,
        mint,
        icon: info.icon,
      });
      seen.add(info.symbol);
    }
  }

  return merged;
}

function SwapTokenIcon({ symbol, icon }: { symbol: string; icon?: string }) {
  if (icon) {
    return <img src={icon} alt={symbol} className="h-8 w-8 rounded-full object-cover shrink-0" />;
  }
  const hue = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return (
    <div
      className="h-8 w-8 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
      style={{ background: `linear-gradient(135deg, oklch(0.60 0.15 ${hue}), oklch(0.45 0.12 ${hue + 30}))` }}
    >
      {symbol.slice(0, 2)}
    </div>
  );
}

function SwapTokenSelector({
  selected,
  tokens,
  onSelect,
  label,
}: {
  selected: Token;
  tokens: Token[];
  onSelect: (t: Token) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">{label}</p>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl bg-background border border-border hover:border-primary/40 transition-colors cursor-pointer"
      >
        <SwapTokenIcon symbol={selected.symbol} icon={selected.icon} />
        <div className="flex-1 text-left">
          <p className="text-sm font-semibold">{selected.symbol}</p>
          <p className="text-[10px] text-muted-foreground">{selected.name}</p>
        </div>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 rounded-xl border border-border bg-card shadow-xl overflow-hidden max-h-48 overflow-y-auto">
          {tokens.map((t) => (
            <button
              key={t.mint ?? t.symbol}
              type="button"
              onClick={() => { onSelect(t); setOpen(false); }}
              className={`flex items-center gap-2.5 w-full px-3 py-2 hover:bg-accent/60 transition-colors cursor-pointer
                ${t.symbol === selected.symbol ? "bg-accent/40" : ""}`}
            >
              <SwapTokenIcon symbol={t.symbol} icon={t.icon} />
              <div className="flex-1 text-left min-w-0">
                <p className="text-sm font-medium">{t.symbol}</p>
              </div>
              <span className="text-[11px] font-mono text-muted-foreground">
                {t.balance > 0 ? t.balance.toFixed(4) : "—"}
              </span>
              {t.symbol === selected.symbol && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SwapView({ balance, onNavigate }: SwapViewProps) {
  const { tokens, activeAccount } = useWalletStore();

  const swappable = getSwappableTokens(tokens);
  // Set SOL balance from prop
  if (swappable[0]?.symbol === "SOL") swappable[0].balance = balance;

  const [fromToken, setFromToken] = useState<Token>(swappable[0]);
  const [toToken, setToToken] = useState<Token>(swappable.find((t) => t.symbol === "USDC") ?? swappable[1] ?? swappable[0]);
  const [inputAmount, setInputAmount] = useState("");
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const parsedInput = parseFloat(inputAmount) || 0;

  const fetchQuote = useCallback(async (amount: number) => {
    if (amount <= 0) { setQuote(null); return; }

    const fromMint = fromToken.mint ?? SOL_MINT;
    const toMint = toToken.mint ?? SOL_MINT;

    if (fromMint === toMint) {
      setError("Cannot swap same token");
      setQuote(null);
      return;
    }

    setQuoteLoading(true);
    setError("");

    try {
      const inLamports = Math.round(amount * 10 ** (fromToken.decimals ?? 9));
      const url = `${JUPITER_QUOTE_API}?inputMint=${fromMint}&outputMint=${toMint}&amount=${inLamports}&slippageBps=50`;
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Quote failed (${res.status})`);
      }
      const data = await res.json();
      setQuote(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to get quote");
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [fromToken, toToken]);

  // Debounced quote fetch
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (parsedInput > 0) {
      debounceRef.current = setTimeout(() => fetchQuote(parsedInput), 500);
    } else {
      setQuote(null);
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [parsedInput, fetchQuote]);

  const handleFlip = () => {
    setFromToken(toToken);
    setToToken(fromToken);
    setInputAmount("");
    setQuote(null);
    setError("");
  };

  const outputAmount = quote
    ? (parseInt(quote.outAmount) / 10 ** (toToken.decimals ?? 9))
    : 0;

  const priceImpact = quote ? parseFloat(quote.priceImpactPct) : 0;
  const route = quote?.routePlan?.map((r) => r.swapInfo.label).join(" → ") ?? "";

  const canSwap = parsedInput > 0 && parsedInput <= (fromToken.balance || 0) && quote && !quoteLoading;

  return (
    <div className="flex flex-col gap-4 p-4 flex-1">
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => onNavigate("dashboard")}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold flex-1 text-center mr-8">Swap</h2>
      </div>

      {/* From token */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <SwapTokenSelector
            selected={fromToken}
            tokens={swappable}
            onSelect={(t) => { setFromToken(t); setQuote(null); }}
            label="You pay"
          />
          <div className="mt-3 relative">
            <Input
              type="number"
              placeholder="0.00"
              value={inputAmount}
              onChange={(e) => { setInputAmount(e.target.value); setError(""); }}
              className="font-mono text-lg pr-16"
              step="0.0001"
              min="0"
            />
            <button
              type="button"
              onClick={() => {
                const max = fromToken.symbol === "SOL"
                  ? Math.max(0, (fromToken.balance || 0) - 0.005)
                  : fromToken.balance || 0;
                setInputAmount(max.toFixed(4));
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-primary font-semibold hover:text-primary/80 cursor-pointer"
            >
              MAX
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Available: {(fromToken.balance || 0).toFixed(4)} {fromToken.symbol}
          </p>
        </CardContent>
      </Card>

      {/* Flip button */}
      <div className="flex justify-center -my-2 z-10">
        <button
          type="button"
          onClick={handleFlip}
          className="h-9 w-9 rounded-full bg-primary/15 border-2 border-background flex items-center justify-center hover:bg-primary/25 transition-colors cursor-pointer"
        >
          <ArrowDownUp className="h-4 w-4 text-primary" />
        </button>
      </div>

      {/* To token */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <SwapTokenSelector
            selected={toToken}
            tokens={swappable}
            onSelect={(t) => { setToToken(t); setQuote(null); }}
            label="You receive"
          />
          <div className="mt-3 bg-muted/40 rounded-lg px-4 py-3 min-h-[48px] flex items-center">
            {quoteLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Getting best route…</span>
              </div>
            ) : outputAmount > 0 ? (
              <span className="font-mono text-lg font-medium">
                {outputAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">Enter an amount</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Quote details */}
      {quote && (
        <div className="bg-card rounded-xl border border-border px-4 py-3 space-y-1.5 text-xs text-muted-foreground">
          <div className="flex justify-between">
            <span>Rate</span>
            <span className="font-mono">
              1 {fromToken.symbol} ≈ {(outputAmount / parsedInput).toFixed(4)} {toToken.symbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Price impact</span>
            <span className={priceImpact > 1 ? "text-destructive" : ""}>
              {priceImpact.toFixed(3)}%
            </span>
          </div>
          {route && (
            <div className="flex justify-between">
              <span>Route</span>
              <span className="text-right max-w-[160px] truncate">{route}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Slippage</span>
            <span>0.5%</span>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-destructive text-xs px-1">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="mt-auto">
        <Button
          className="w-full gap-2"
          size="lg"
          disabled={!canSwap}
          onClick={() => {
            // Swap execution via Jupiter swap API would go here
            // For now show a preview toast
            setError("Swap execution coming soon — quote preview only");
          }}
        >
          <ArrowDownUp className="h-4 w-4" />
          {quoteLoading ? "Getting quote…" : parsedInput > 0 && parsedInput > (fromToken.balance || 0) ? "Insufficient balance" : "Swap"}
        </Button>
        <p className="text-[10px] text-muted-foreground text-center mt-2 flex items-center justify-center gap-1">
          Powered by Jupiter
          <a href="https://jup.ag" target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </p>
      </div>
    </div>
  );
}
