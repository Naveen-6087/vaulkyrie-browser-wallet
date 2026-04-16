import { useState } from "react";
import { Copy, Check, Share2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { copyToClipboard } from "@/lib/utils";
import { useWalletStore } from "@/store/walletStore";
import type { WalletView } from "@/types";

interface ReceiveViewProps {
  address: string;
  onNavigate: (view: WalletView) => void;
}

export function ReceiveView({ address, onNavigate }: ReceiveViewProps) {
  const [copied, setCopied] = useState(false);
  const { network } = useWalletStore();

  const solanaUri = address ? `solana:${address}` : "no-address";
  const networkLabel = network === "mainnet" ? "Mainnet" : network === "devnet" ? "Devnet" : "Testnet";

  const handleCopy = async () => {
    await copyToClipboard(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
    <div className="flex flex-col gap-4 p-4 flex-1">
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => onNavigate("dashboard")}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold flex-1 text-center mr-8">
          Receive SOL
        </h2>
      </div>

      {/* Real QR Code with solana: URI */}
      <Card className="flex flex-col items-center justify-center p-8">
        <div className="relative rounded-xl bg-white p-3 mb-4">
          <div className="absolute -inset-2 bg-primary/10 rounded-2xl blur-lg" />
          <QRCodeSVG
            value={solanaUri}
            size={176}
            bgColor="#ffffff"
            fgColor="#0a0a0a"
            level="M"
            className="relative"
          />
        </div>
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
            network === "mainnet"
              ? "bg-emerald-500/20 text-emerald-400"
              : "bg-amber-500/20 text-amber-400"
          }`}>
            {networkLabel}
          </span>
        </div>
        <p className="text-xs text-muted-foreground text-center mb-1">
          Scan with any Solana wallet to send
        </p>
        <p className="text-xs text-muted-foreground font-mono text-center break-all px-4">
          {address}
        </p>
      </Card>

      {/* Address copy */}
      <Card className="p-4">
        <p className="text-xs text-muted-foreground mb-2">Your address</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs font-mono bg-muted rounded-lg px-3 py-2.5 break-all">
            {address}
          </code>
        </div>
        <div className="flex gap-2 mt-3">
          <Button
            variant="secondary"
            className="flex-1 gap-2"
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <Check className="h-4 w-4 text-success" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                Copy address
              </>
            )}
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleShare}
          >
            <Share2 className="h-4 w-4" />
          </Button>
        </div>
      </Card>

      <p className="text-[10px] text-muted-foreground text-center mt-auto">
        Only send Solana (SOL) and SPL tokens to this address
      </p>
    </div>
  );
}
