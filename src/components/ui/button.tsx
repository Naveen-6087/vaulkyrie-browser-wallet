import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "secondary" | "ghost" | "outline" | "destructive";
  size?: "default" | "sm" | "lg" | "icon";
}

const variantStyles: Record<string, string> = {
  default:
    "bg-primary text-primary-foreground shadow-[0_18px_40px_-24px_var(--color-primary)] hover:bg-primary/92 hover:shadow-[0_22px_45px_-24px_var(--color-primary)]",
  secondary:
    "border border-border/80 bg-secondary/85 text-secondary-foreground hover:bg-secondary",
  ghost: "hover:bg-accent/80 hover:text-accent-foreground",
  outline:
    "border border-border/80 bg-card/40 text-foreground hover:bg-accent/75 hover:text-accent-foreground",
  destructive:
    "bg-destructive text-destructive-foreground shadow-[0_18px_40px_-28px_var(--color-destructive)] hover:bg-destructive/92",
};

const sizeStyles: Record<string, string> = {
  default: "h-10 px-4 py-2 text-sm",
  sm: "h-8 px-3 text-xs",
  lg: "h-11 px-6 text-sm",
  icon: "h-10 w-10",
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    return (
        <button
          className={cn(
            "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.985] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer",
            variantStyles[variant],
            sizeStyles[size],
            className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button };
