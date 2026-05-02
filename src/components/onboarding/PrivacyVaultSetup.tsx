import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2, Shield, WalletCards } from "lucide-react";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import {
  createPrivacyVaultAccountInBackground,
} from "@/lib/internalWalletRpc";
import { hasWalletSessionPassword, setWalletSessionPassword } from "@/lib/walletSession";
import { getWalletAccountLabel } from "@/lib/walletAccounts";
import { validatePrivacyVaultMnemonic } from "@/services/privacyVault/mnemonic";
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
  const [showMnemonicImport, setShowMnemonicImport] = useState(false);
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [generatedMnemonic, setGeneratedMnemonic] = useState("");
  const [copied, setCopied] = useState(false);
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

  const copyRecoveryPhrase = async () => {
    if (!generatedMnemonic) {
      return;
    }
    await navigator.clipboard.writeText(generatedMnemonic);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

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
    if (showMnemonicImport && !validatePrivacyVaultMnemonic(mnemonicInput)) {
      setError("Enter a valid BIP39 recovery phrase for this Privacy Vault.");
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

      const { account, keyRecord, recoveryPhrase } = await createPrivacyVaultAccountInBackground({
        name: trimmedName,
        mnemonic: showMnemonicImport ? mnemonicInput : undefined,
      });

      storePrivacyVaultKey(account.publicKey, keyRecord);
      addAccount(account);
      setActiveAccount(account);
      setOnboarded(true);
      setLocked(false);
      if (recoveryPhrase) {
        setGeneratedMnemonic(recoveryPhrase);
        setMnemonicInput("");
      } else {
        onComplete();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to create the Privacy Vault.");
    } finally {
      setIsCreating(false);
    }
  };

  if (generatedMnemonic) {
    return (
      <ScreenShell
        title="Back up Privacy Vault"
        description="Store this recovery phrase offline before you continue. Umbra privacy keys stay derived internally from this wallet signer, so there is no second Umbra phrase to save."
        onBack={() => setGeneratedMnemonic("")}
        backLabel="Back"
      >
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/12">
                <Shield className="h-4 w-4 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold">Recovery phrase required</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  This mnemonic restores the local signer for this Privacy Vault. Your wallet password only unlocks this browser profile.
                </p>
              </div>
            </div>
            <code className="block rounded-2xl border border-border/80 bg-card/55 px-3 py-3 text-xs font-mono leading-relaxed text-foreground">
              {generatedMnemonic}
            </code>
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-3 py-3 text-xs leading-relaxed text-amber-100">
              Write this phrase down offline. Do not store it in screenshots, notes apps, chat, or cloud drives.
            </div>
            <Button variant="secondary" className="w-full gap-2" onClick={() => void copyRecoveryPhrase()}>
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy recovery phrase"}
            </Button>
            <Button
              className="w-full gap-2"
              onClick={() => {
                setGeneratedMnemonic("");
                onComplete();
              }}
            >
              Continue to wallet
            </Button>
          </Card>
        </div>
      </ScreenShell>
    );
  }

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
             Vaults when you want a simpler private wallet rail with its own recovery phrase.
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

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={showMnemonicImport ? "outline" : "secondary"}
              className="gap-2"
              onClick={() => {
                setShowMnemonicImport(false);
                setError("");
              }}
              disabled={isCreating}
            >
              Create new phrase
            </Button>
            <Button
              type="button"
              variant={showMnemonicImport ? "secondary" : "outline"}
              className="gap-2"
              onClick={() => {
                setShowMnemonicImport(true);
                setError("");
              }}
              disabled={isCreating}
            >
              Import phrase
            </Button>
          </div>

          {showMnemonicImport && (
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Recovery phrase
              </label>
              <textarea
                value={mnemonicInput}
                onChange={(event) => {
                  setMnemonicInput(event.target.value);
                  setError("");
                }}
                placeholder="BIP39 recovery phrase"
                className="min-h-24 w-full resize-none rounded-2xl border border-input bg-background px-3 py-3 text-xs font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Import restores the same Privacy Vault signer. Umbra account state stays tied to that signer, so there is no separate Umbra seed phrase to enter.
              </p>
            </div>
          )}

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
                The signer is derived locally from a BIP39 phrase and encrypted with your Vaulkyrie wallet password before it is persisted.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </ScreenShell>
  );
}
