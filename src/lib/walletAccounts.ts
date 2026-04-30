import type { WalletAccount, WalletAccountKind } from "@/types";

export const DEFAULT_WALLET_ACCOUNT_KIND: WalletAccountKind = "threshold-vault";

export function getWalletAccountKind(
  account: Pick<WalletAccount, "kind"> | null | undefined,
): WalletAccountKind {
  return account?.kind === "privacy-vault" ? "privacy-vault" : DEFAULT_WALLET_ACCOUNT_KIND;
}

export function isPrivacyVaultAccount(
  account: Pick<WalletAccount, "kind"> | null | undefined,
): boolean {
  return getWalletAccountKind(account) === "privacy-vault";
}

export function getWalletAccountLabel(
  account: Pick<WalletAccount, "kind"> | null | undefined,
): string {
  return isPrivacyVaultAccount(account) ? "Privacy Vault" : "Threshold Vault";
}
