import { Copy, Check, Share2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScreenShell } from "@/components/layout/ScreenShell";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useWalletStore } from "@/store/walletStore";
import type { WalletView } from "@/types";

interface ReceiveViewProps {
  address: string;
  onNavigate: (view: WalletView) => void;
}

export function ReceiveView({ address, onNavigate }: ReceiveViewProps) {
  const { network } = useWalletStore();
  const { copy, isCopied, copyError } = useCopyToClipboard({ resetAfterMs: 2000 });

  const solanaUri = address ? `solana:${address}` : "no-address";
  const networkLabel = network === "mainnet" ? "Mainnet" : network === "devnet" ? "Devnet" : "Testnet";

  const handleCopy = async () => {
    await copy(address, "receive-address");
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Vaulkyrie Wallet Address",
          text: `Send SOL to: ${address}`,
          url: solanaUri,
        });
      } catch {
        // user cancelled share
      }
    } else {
      await handleCopy();
    }
  };

  return (
    <ScreenShell
      title="Receive SOL"
      description="Share your vault address or QR code to receive SOL and SPL tokens."
      onBack={() => onNavigate("dashboard")}
      backLabel="Back to dashboard"
      actions={(
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-semibold ${
            network === "mainnet"
              ? "bg-emerald-500/20 text-emerald-400"
              : "bg-amber-500/20 text-amber-400"
          }`}
        >
          {networkLabel}
        </span>
      )}
    >
      <div className="space-y-4">
        <Card className="flex flex-col items-center justify-center p-6 text-center">
          <div className="relative mb-4 rounded-2xl bg-white p-3">
            <div className="absolute -inset-2 rounded-[1.4rem] bg-primary/10 blur-lg" />
            <QRCodeSVG
              value={solanaUri}
              size={176}
              bgColor="#ffffff"
              fgColor="#0a0a0a"
              level="M"
              className="relative"
            />
          </div>
          <p className="text-sm font-medium">Scan to send funds</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Any Solana wallet can use this QR code or address.
          </p>
          <p className="mt-3 break-all px-2 text-xs font-mono text-muted-foreground">
            {address}
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Your address
          </p>
          <code className="mt-3 block rounded-2xl border border-border/80 bg-background/75 px-3 py-3 text-xs font-mono break-all">
            {address}
          </code>
          {copyError && <p className="mt-2 text-xs text-destructive">{copyError}</p>}
          <div className="mt-3 flex gap-2">
            <Button
              variant={isCopied("receive-address") ? "secondary" : "default"}
              className="flex-1 gap-2"
              onClick={handleCopy}
            >
              {isCopied("receive-address") ? (
                <>
                  <Check className="h-4 w-4 text-success" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy address
                </>
              )}
            </Button>
            <Button variant="outline" className="gap-2" onClick={handleShare}>
              <Share2 className="h-4 w-4" />
              Share
            </Button>
          </div>
        </Card>

        <p className="text-center text-[11px] text-muted-foreground">
          Only send Solana (SOL) and SPL tokens to this address.
        </p>
      </div>
    </ScreenShell>
  );
}
