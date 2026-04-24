import { useState } from "react";
import { ImageIcon, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Collectible, WalletView } from "@/types";

interface CollectiblesGridProps {
  collectibles: Collectible[];
  isLoading: boolean;
  onNavigate: (view: WalletView) => void;
}

function CollectibleArtwork({
  collectible,
  compact = false,
}: {
  collectible: Collectible;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const hue = collectible.mint.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;

  if (collectible.image && !failed) {
    return (
      <img
        src={collectible.image}
        alt={collectible.name}
        className={`w-full object-cover ${compact ? "aspect-square rounded-xl" : "aspect-square rounded-2xl"}`}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className={`w-full ${compact ? "aspect-square rounded-xl" : "aspect-square rounded-2xl"} flex items-center justify-center`}
      style={{
        background: `linear-gradient(135deg, oklch(0.58 0.12 ${hue}), oklch(0.42 0.1 ${hue + 36}))`,
      }}
    >
      <div className="flex flex-col items-center gap-2 text-white">
        <ImageIcon className="h-6 w-6" aria-hidden="true" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">
          {collectible.symbol?.slice(0, 3) ?? "NFT"}
        </span>
      </div>
    </div>
  );
}

export function CollectiblesGrid({
  collectibles,
  isLoading,
  onNavigate,
}: CollectiblesGridProps) {
  const preview = collectibles.slice(0, 6);
  const hiddenCount = Math.max(collectibles.length - preview.length, 0);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Collectibles
        </h3>
        {collectibles.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {collectibles.length} owned
          </span>
        )}
      </div>

      {isLoading && collectibles.length === 0 ? (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index} className="overflow-hidden p-2">
              <div className="aspect-square rounded-2xl bg-muted animate-pulse" />
              <div className="px-1 py-2 space-y-2">
                <div className="h-3 rounded bg-muted animate-pulse" />
                <div className="h-2 rounded bg-muted/70 animate-pulse w-2/3" />
              </div>
            </Card>
          ))}
        </div>
      ) : collectibles.length === 0 ? (
        <Card className="p-5 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium">No collectibles found</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Send an NFT to this address and it will appear here automatically.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => onNavigate("receive")}
          >
            Show receive address
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {preview.map((collectible) => (
            <Card key={collectible.mint} className="overflow-hidden border-border/70 bg-card/80 p-2">
              <CollectibleArtwork collectible={collectible} />
              <div className="px-1 pb-1 pt-3">
                <p className="truncate text-sm font-medium">{collectible.name}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {collectible.collection ?? collectible.symbol ?? collectible.mint.slice(0, 8)}
                </p>
              </div>
            </Card>
          ))}
          {hiddenCount > 0 && (
            <Card className="flex aspect-square items-center justify-center border-dashed border-border/80 bg-card/40 p-4 text-center">
              <div>
                <p className="text-lg font-semibold">+{hiddenCount}</p>
                <p className="text-[11px] text-muted-foreground">More collectibles in wallet</p>
              </div>
            </Card>
          )}
        </div>
      )}
    </section>
  );
}
