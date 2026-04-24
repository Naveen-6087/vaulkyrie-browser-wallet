import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function formatSol(lamports: number): string {
  return (safeNumber(lamports) / 1e9).toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

export function formatTokenAmount(amount: number, maximumFractionDigits = 4): string {
  return safeNumber(amount).toLocaleString(undefined, {
    maximumFractionDigits,
  });
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(safeNumber(amount));
}

export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
