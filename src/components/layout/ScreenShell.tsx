import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ScreenHeader } from "@/components/layout/ScreenHeader";

interface ScreenShellProps {
  title: string;
  description?: string;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function ScreenShell({
  title,
  description,
  onBack,
  backLabel,
  actions,
  children,
  className,
  contentClassName,
}: ScreenShellProps) {
  return (
    <div className={cn("flex h-full flex-col", className)}>
      <ScreenHeader
        title={title}
        description={description}
        onBack={onBack}
        backLabel={backLabel}
        actions={actions}
      />
      <div className={cn("flex-1 overflow-y-auto px-4 pb-5 pt-4", contentClassName)}>
        {children}
      </div>
    </div>
  );
}
