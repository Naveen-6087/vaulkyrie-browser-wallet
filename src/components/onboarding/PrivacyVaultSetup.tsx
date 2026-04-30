import { useEffect, useState } from "react";
import { KeyRound, Loader2, Shield, WalletCards } from "lucide-react";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import {
  createPrivacyVaultAccountInBackground,
} from "@/lib/internalWalletRpc";
import { hasWalletSessionPassword, setWalletSessionPassword } from "@/lib/walletSession";
import { getWalletAccountLabel } from "@/lib/walletAccounts";
import { ScreenShell } from "@/components/layout/ScreenShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useWalletStore } from "@/store/walletStore";

interface PrivacyVaultSetupProps {
  onBack: () => void;
  onComplete: () => void;
}

export function PrivacyVaultSetup({ onBack, onComplete }: PrivacyVaultSetupProps) {
  const [name, setName] = useState("Privacy Vault");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const {
    passwordHash,
    passwordSalt,
    addAccount,
    setActiveAccount,
    setOnboarded,
    setLocked,
    setPasswordHash,
    storePrivacyVaultKey,
  } = useWalletStore();
  const needsPasswordSetup = !passwordHash;
  const needsUnlockPassword = Boolean(passwordHash) && !hasSession;

  useEffect(() => {
    let cancelled = false;
    void hasWalletSessionPassword()
      .then((unlocked) => {
        if (!cancelled) {
          setHasSession(unlocked);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHasSession(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreate = async () => {
    if (isCreating) {
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a name for this Privacy Vault.");
      return;
    }

    if (needsPasswordSetup) {
      if (password.length < 10) {
        setError("Password must be at least 10 characters.");
        return;
      }
      if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        setError("Use at least one letter and one number in the password.");
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
    } else if (needsUnlockPassword && !password) {
      setError("Enter your wallet password to unlock Vaulkyrie.");
      return;
    }

    setIsCreating(true);
    setError("");

    try {
      if (needsPasswordSetup) {
        const { hash, salt } = await hashPassword(password);
        setPasswordHash(hash, salt);
        await setWalletSessionPassword(password);
        setHasSession(true);
      } else if (needsUnlockPassword) {
        const valid = await verifyPassword(password, passwordHash!, passwordSalt!);
        if (!valid) {
          throw new Error("Incorrect password");
        }
        await setWalletSessionPassword(password);
        setHasSession(true);
      }

      const { account, keyRecord } = await createPrivacyVaultAccountInBackground({
        name: trimmedName,
      });

      storePrivacyVaultKey(account.publicKey, keyRecord);
      addAccount(account);
      setActiveAccount(account);
      setOnboarded(true);
      setLocked(false);
      onComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to create the Privacy Vault.");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <ScreenShell
      title="Create Privacy Vault"
      description="Spin up a dedicated Vaulkyrie privacy wallet with a normal Ed25519 signer for Umbra flows."
      onBack={onBack}
      backLabel="Back"
    >
      <div className="space-y-4">
        <Card className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/12">
              <Shield className="h-4 w-4 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold">{getWalletAccountLabel({ kind: "privacy-vault" })}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                This account skips FROST DKG and uses a locally generated signer dedicated to private
                sends, private inboxes, and Umbra-native signing.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-border/80 bg-card/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
            Use Threshold Vaults for distributed custody and Vaulkyrie coordination. Use Privacy
            Vaults when you want a simpler private wallet rail.
          </div>
        </Card>

        <Card className="space-y-4 p-4">
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Vault name
            </label>
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
              placeholder="Privacy Vault"
            />
          </div>

          {(needsPasswordSetup || needsUnlockPassword) && (
            <>
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  {needsPasswordSetup ? "Wallet password" : "Unlock wallet"}
                </label>
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError("");
                  }}
                  placeholder={needsPasswordSetup ? "At least 10 characters" : "Enter your existing password"}
                  autoComplete={needsPasswordSetup ? "new-password" : "current-password"}
                />
              </div>
              {needsPasswordSetup && (
                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Confirm password
                  </label>
                  <Input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => {
                      setConfirmPassword(event.target.value);
                      setError("");
                    }}
                    placeholder="Repeat the password"
                    autoComplete="new-password"
                  />
                </div>
              )}
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button className="w-full gap-2" onClick={handleCreate} disabled={isCreating}>
            {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <WalletCards className="h-4 w-4" />}
            Create Privacy Vault
          </Button>
        </Card>

        <Card className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/80">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold">Storage model</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                The signer is generated locally and encrypted with your Vaulkyrie wallet password
                before it is persisted.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </ScreenShell>
  );
}
