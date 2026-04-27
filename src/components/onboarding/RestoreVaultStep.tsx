import { useState, type ChangeEvent } from "react";
import { motion } from "framer-motion";
import { Download, FileUp, KeyRound, Loader2, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  importEncryptedWalletBackup,
  previewEncryptedWalletBackup,
  type WalletBackupPreview,
} from "@/lib/walletBackup";
import { shortenAddress } from "@/lib/utils";

interface RestoreVaultStepProps {
  onBack: () => void;
  onRestored: () => void;
}

export function RestoreVaultStep({ onBack, onRestored }: RestoreVaultStepProps) {
  const [backupJson, setBackupJson] = useState("");
  const [backupPassword, setBackupPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<WalletBackupPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const handleFileImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      setBackupJson(text);
      setError("");
      setPreview(null);
    } catch {
      setError("Failed to read the selected backup file.");
    } finally {
      event.target.value = "";
    }
  };

  const handleRestore = async () => {
    if (!backupJson.trim()) {
      setError("Paste a backup JSON payload or choose a backup file first.");
      return;
    }
    if (!backupPassword) {
      setError("Enter the backup password used when exporting this wallet.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      await importEncryptedWalletBackup(backupJson, backupPassword);
      onRestored();
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "Failed to restore wallet backup.");
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    if (!backupJson.trim()) {
      setError("Paste a backup JSON payload or choose a backup file first.");
      return;
    }
    if (!backupPassword) {
      setError("Enter the backup password used when exporting this wallet.");
      return;
    }

    setPreviewing(true);
    setError("");
    try {
      const nextPreview = await previewEncryptedWalletBackup(backupJson, backupPassword);
      setPreview(nextPreview);
    } catch (previewError) {
      setPreview(null);
      setError(previewError instanceof Error ? previewError.message : "Failed to preview wallet backup.");
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden px-5 pt-6 pb-5">
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="mb-5"
      >
        <button
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
        >
          ← Back
        </button>
      </motion.div>

      <motion.div
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.05 }}
        className="mb-5 text-center"
      >
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15">
          <Download className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-xl font-bold">Restore Existing Vault</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Import an encrypted Vaulkyrie backup created from Settings. This restores your local vault state, DKG packages, contacts, and policy profiles on this device.
        </p>
      </motion.div>

      <div className="flex flex-col gap-4">
        <Card className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
              <Shield className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold">Encrypted local restore</p>
              <p className="text-xs text-muted-foreground mt-1">
                Restore rehydrates your local vault state, saved DKG packages, activity history, and any staged recovery sessions from an encrypted Vaulkyrie backup.
              </p>
            </div>
          </div>
        </Card>

        <Card className="p-4 space-y-3">
          <div>
            <p className="text-sm font-medium mb-2">Backup file</p>
            <label className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/60 px-4 py-4 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors">
              <FileUp className="h-4 w-4" />
              Choose encrypted backup JSON
              <input type="file" accept="application/json,.json" className="hidden" onChange={handleFileImport} />
            </label>
          </div>

          <div>
            <p className="text-sm font-medium mb-2">Or paste backup JSON</p>
            <textarea
              value={backupJson}
              onChange={(event) => {
                setBackupJson(event.target.value);
                setPreview(null);
              }}
              placeholder='{"kind":"vaulkyrie-wallet-backup", ...}'
              className="min-h-36 w-full rounded-xl border border-border bg-background px-3 py-3 text-xs font-mono text-foreground placeholder:text-muted-foreground/50"
            />
          </div>

          <div>
            <p className="text-sm font-medium mb-2">Backup password</p>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="password"
                value={backupPassword}
                onChange={(event) => {
                  setBackupPassword(event.target.value);
                  setPreview(null);
                }}
                placeholder="Password used to encrypt this backup"
                className="pl-10"
              />
            </div>
          </div>

          {preview && (
            <div className="rounded-xl border border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground space-y-2">
              <p className="text-sm font-medium text-foreground">Backup preview</p>
              <p>Exported: {new Date(preview.exportedAt).toLocaleString()}</p>
              <p>Network: {preview.network}</p>
              <p>Accounts: {preview.accounts.map((account) => `${account.name} (${shortenAddress(account.publicKey)})`).join(", ")}</p>
              <p>
                Contacts: {preview.contactCount} · Policies: {preview.policyProfileCount} · Activity: {preview.orchestrationActivityCount} · Recovery sessions: {preview.recoverySessionCount}
              </p>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button variant="outline" className="w-full gap-2" onClick={handlePreview} disabled={loading || previewing}>
              {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
              Preview backup
            </Button>
            <Button className="w-full gap-2" onClick={handleRestore} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Restore vault backup
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
