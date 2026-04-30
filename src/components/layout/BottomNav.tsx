import {
  Home,
  ArrowUpRight,
  ArrowLeftRight,
  ArrowDownLeft,
  Settings,
  Atom,
  Shield,
  RadioTower,
} from "lucide-react";
import { getWalletAccountKind } from "@/lib/walletAccounts";
import { cn } from "@/lib/utils";
import { useWalletStore } from "@/store/walletStore";
import type { WalletView } from "@/types";

interface BottomNavProps {
  active: WalletView;
  onNavigate: (view: WalletView) => void;
}

export function BottomNav({ active, onNavigate }: BottomNavProps) {
  const activeAccount = useWalletStore((state) => state.activeAccount);
  const navItems: { view: WalletView; icon: typeof Home; label: string }[] =
    getWalletAccountKind(activeAccount) === "privacy-vault"
      ? [
          { view: "dashboard", icon: Home, label: "Home" },
          { view: "swap", icon: ArrowLeftRight, label: "Swap" },
          { view: "privacy", icon: Shield, label: "Privacy" },
          { view: "receive", icon: ArrowDownLeft, label: "Receive" },
          { view: "activity", icon: RadioTower, label: "Activity" },
          { view: "settings", icon: Settings, label: "Settings" },
        ]
      : [
          { view: "dashboard", icon: Home, label: "Home" },
          { view: "send", icon: ArrowUpRight, label: "Send" },
          { view: "quantum-vault", icon: Atom, label: "PQC" },
          { view: "privacy", icon: Shield, label: "Privacy" },
          { view: "receive", icon: ArrowDownLeft, label: "Receive" },
          { view: "settings", icon: Settings, label: "Settings" },
        ];

  return (
    <nav
      className="grid gap-1 border-t border-border/70 bg-card/80 px-2 py-2 backdrop-blur-md"
      style={{ gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))` }}
    >
      {navItems.map(({ view, icon: Icon, label }) => {
        const isActive = active === view;
        return (
          <button
            key={view}
            onClick={() => onNavigate(view)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-1 rounded-2xl px-2 py-2 text-center transition-[background-color,color,transform] duration-200 cursor-pointer active:scale-[0.98]",
              isActive
                ? "bg-primary/10 text-primary shadow-[inset_0_0_0_1px_rgba(78,205,196,0.16)]"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="h-5 w-5" strokeWidth={isActive ? 2.2 : 1.8} />
            <span className="text-[10px] font-medium leading-none">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
