import {
  Home,
  ArrowUpRight,
  ArrowDownLeft,
  Settings,
  Atom,
  Shield,
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
  { view: "privacy", icon: Shield, label: "Privacy" },
  { view: "quantum-vault", icon: Atom, label: "PQC" },
  { view: "receive", icon: ArrowDownLeft, label: "Receive" },
  { view: "settings", icon: Settings, label: "Settings" },
];

export function BottomNav({ active, onNavigate }: BottomNavProps) {
  return (
    <nav className="grid grid-cols-6 gap-1 border-t border-border/70 bg-card/80 px-2 py-2 backdrop-blur-md">
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
