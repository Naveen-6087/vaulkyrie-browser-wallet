import {
  Home,
  ArrowUpRight,
  ArrowDownLeft,
  Settings,
  Atom,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WalletView } from "@/types";

interface BottomNavProps {
  active: WalletView;
  onNavigate: (view: WalletView) => void;
}

const navItems: { view: WalletView; icon: typeof Home; label: string }[] = [
  { view: "dashboard", icon: Home, label: "Home" },
  { view: "send", icon: ArrowUpRight, label: "Send" },
  { view: "quantum-vault", icon: Atom, label: "Vault" },
  { view: "receive", icon: ArrowDownLeft, label: "Receive" },
  { view: "settings", icon: Settings, label: "Settings" },
];

export function BottomNav({ active, onNavigate }: BottomNavProps) {
  return (
    <nav className="flex items-center justify-around border-t border-border bg-card/80 backdrop-blur-md px-2 py-1.5">
      {navItems.map(({ view, icon: Icon, label }) => {
        const isActive = active === view;
        return (
          <button
            key={view}
            onClick={() => onNavigate(view)}
            className={cn(
              "flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors cursor-pointer",
              isActive
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-5 w-5" strokeWidth={isActive ? 2.2 : 1.8} />
            <span className="text-[10px] font-medium">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
