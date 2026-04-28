import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ScreenHeaderProps {
  title: string;
  description?: string;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  className?: string;
}

export function ScreenHeader({
  title,
  description,
  onBack,
  backLabel = "Go back",
  actions,
  className,
}: ScreenHeaderProps) {
  return (
    <div
      className={cn(
        "border-b border-border/70 bg-background/80 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {onBack && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label={backLabel}
            className="-ml-1 mt-0.5 h-9 w-9 rounded-xl text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
              {description && (
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
            {actions && <div className="shrink-0">{actions}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
