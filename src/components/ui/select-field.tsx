import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  shellClassName?: string;
}

const SelectField = React.forwardRef<HTMLSelectElement, SelectFieldProps>(
  ({ className, shellClassName, children, ...props }, ref) => {
    return (
      <div className={cn("relative", shellClassName)}>
        <select
          ref={ref}
          className={cn(
            "w-full appearance-none rounded-xl border border-border/75 bg-card/95 px-3 py-2.5 pr-10 text-sm text-foreground shadow-[0_12px_30px_-24px_rgba(15,23,42,0.85)] transition-[border-color,box-shadow,background-color] outline-none hover:border-primary/35 focus:border-primary/50 focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60",
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">
          <ChevronDown className="h-4 w-4" />
        </span>
      </div>
    );
  },
);

SelectField.displayName = "SelectField";

export { SelectField };
