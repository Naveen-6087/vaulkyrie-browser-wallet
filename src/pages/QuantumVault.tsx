/**
 * Vaulkyrie quantum vault page.
 *
 * Uses the Blueshift-style Winternitz vault flow onchain:
 *   - generate a one-time Winternitz key locally
 *   - open the bound quantum vault PDA onchain
 *   - fund that PDA like a receive address
 *   - spend it exactly once via split or close
 *
 * This is separate from the root-rolling Winter/XMSS authority account.
 */

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield,
  Lock,
  Unlock,
  AlertTriangle,
  ArrowRight,
  Check,
  Loader2,
  Copy,
  Info,
  Atom,
  ExternalLink,
} from "lucide-react";
import { LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  generateWotsKeyPair,
  wotsSignMessage,
  wotsVerifyMessage,
  quantumSplitMessage,
  quantumCloseMessage,
  bytesToHex,
  deserializeWotsKeyPair,
  serializeWotsKeyPair,
  serializeWotsSignature,
} from "@/services/quantum/wots";
import type { WalletView } from "@/types";
import { useWalletStore } from "@/store/walletStore";
import { withRpcFallback } from "@/services/solanaRpc";
import {
  createInitQuantumVaultInstruction,
  createSplitQuantumVaultInstruction,
  createCloseQuantumVaultInstruction,
} from "@/sdk/instructions";
import { findQuantumVaultPda } from "@/sdk/pda";
import { signAndSendTransaction } from "@/services/frost/signTransaction";
import { VaulkyrieClient } from "@/sdk/client";

// ── Vault Status ─────────────────────────────────────────────────────

const VaultStatus = {
  None: "none",
  Active: "active",
} as const;

type VaultStatusType = (typeof VaultStatus)[keyof typeof VaultStatus];

interface QuantumVaultState {
  status: VaultStatusType;
  balanceLamports: number;
  vaultAddress: string;
  publicKeyHashHex: string;
  hasLocalKey: boolean;
  authorityRootHex: string;
  authorityNextLeafIndex: number | null;
  authorityNextSequence: bigint | null;
  hasWinterAuthorityState: boolean;
}

interface QuantumVaultProps {
  walletAddress: string;
  onNavigate: (view: WalletView) => void;
}

export function QuantumVault({ walletAddress, onNavigate }: QuantumVaultProps) {
  const {
    activeAccount,
    network,
    getQuantumVaultKey,
    storeQuantumVaultKey,
    clearQuantumVaultKey,
    getWinterAuthorityState,
    refreshBalances,
    refreshTransactions,
  } = useWalletStore();
  const [vault, setVault] = useState<QuantumVaultState>({
    status: VaultStatus.None,
    balanceLamports: 0,
    vaultAddress: "",
    publicKeyHashHex: "",
    hasLocalKey: false,
    authorityRootHex: "",
    authorityNextLeafIndex: null,
    authorityNextSequence: null,
    hasWinterAuthorityState: false,
  });

  const [activePanel, setActivePanel] = useState<
    "overview" | "open" | "split" | "close" | null
  >("overview");
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [splitAmount, setSplitAmount] = useState("");
  const [splitDestination, setSplitDestination] = useState("");
  const [lastProofHex, setLastProofHex] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);

  const refreshQuantumVault = useCallback(async () => {
    if (!walletAddress) return;

    let hasLocalKey = false;
    let vaultAddress = "";
    let publicKeyHashHex = "";
    let balanceLamports = 0;
    let status: VaultStatusType = VaultStatus.None;

    const serializedKey = getQuantumVaultKey(walletAddress);
    if (serializedKey) {
      try {
        const keyPair = deserializeWotsKeyPair(serializedKey);
        hasLocalKey = true;
        publicKeyHashHex = bytesToHex(keyPair.publicKeyHash);
        const [vaultPda] = findQuantumVaultPda(keyPair.publicKeyHash);
        vaultAddress = vaultPda.toBase58();

        await withRpcFallback(network, async (connection) => {
          const accountInfo = await connection.getAccountInfo(vaultPda);
          if (accountInfo) {
            balanceLamports = accountInfo.lamports;
            status = VaultStatus.Active;
          }
        });
      } catch (error) {
        console.warn("Failed to restore stored quantum vault key:", error);
      }
    }

    let authorityRootHex = "";
    let authorityNextLeafIndex: number | null = null;
    let authorityNextSequence: bigint | null = null;
    const hasWinterAuthorityState = getWinterAuthorityState(walletAddress) !== null;

    try {
      await withRpcFallback(network, async (connection) => {
        const client = new VaulkyrieClient(connection);
        const walletPubkey = new PublicKey(walletAddress);
        const vaultRegistry = await client.getVaultRegistry(walletPubkey);
        if (vaultRegistry) {
          const authority = await client.getQuantumAuthority(vaultRegistry.address);
          if (authority) {
            authorityRootHex = bytesToHex(authority.account.currentAuthorityRoot);
            authorityNextLeafIndex = authority.account.nextLeafIndex;
            authorityNextSequence = authority.account.nextSequence;
          }
        }
      });
    } catch (error) {
      console.warn("Failed to fetch quantum authority state:", error);
    }

    setVault({
      status,
      balanceLamports,
      vaultAddress,
      publicKeyHashHex,
      hasLocalKey,
      authorityRootHex,
      authorityNextLeafIndex,
      authorityNextSequence,
      hasWinterAuthorityState,
    });
  }, [getQuantumVaultKey, getWinterAuthorityState, network, walletAddress]);

  useEffect(() => {
    void refreshQuantumVault();
  }, [refreshQuantumVault]);

  // ── Open Vault ───────────────────────────────────────────────────

  const handleOpenVault = async () => {
    if (!activeAccount?.publicKey) return;

    setIsProcessing(true);
    setStatusMessage("Generating a Winternitz one-time key...");

    try {
      const keyPair = await generateWotsKeyPair();
      const payer = new PublicKey(activeAccount.publicKey);
      const [vaultPda, bump] = findQuantumVaultPda(keyPair.publicKeyHash);

      setStatusMessage("Opening the onchain quantum vault PDA...");
      const signature = await withRpcFallback(network, async (connection) => {
        const existing = await connection.getAccountInfo(vaultPda);
        if (existing) {
          throw new Error("A quantum vault already exists for this stored Winternitz key.");
        }

        const ix = createInitQuantumVaultInstruction(payer, vaultPda, {
          hash: keyPair.publicKeyHash,
          bump,
        });
        const tx = new Transaction().add(ix);
        return signAndSendTransaction(
          connection,
          tx,
          activeAccount.publicKey,
          (msg) => setStatusMessage(msg),
        );
      });

      storeQuantumVaultKey(walletAddress, serializeWotsKeyPair(keyPair));
      setLastProofHex("");
      setStatusMessage(
        `Quantum vault opened. Fund ${vaultPda.toBase58()} before using split or close. Tx: ${signature}`,
      );
      setActivePanel("overview");
      await Promise.all([refreshQuantumVault(), refreshBalances(), refreshTransactions()]);
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Split Vault ──────────────────────────────────────────────────

  const handleSplitVault = async () => {
    if (!activeAccount?.publicKey || !vault.vaultAddress) return;

    const amount = parseFloat(splitAmount);
    if (isNaN(amount) || amount <= 0) {
      setStatusMessage("Enter a valid amount");
      return;
    }

    setIsProcessing(true);
    setStatusMessage("Building Winternitz split authorization...");

    try {
      const serializedKey = getQuantumVaultKey(walletAddress);
      if (!serializedKey) {
        throw new Error("No local Winternitz key found for this quantum vault.");
      }

      const keyPair = deserializeWotsKeyPair(serializedKey);
      const amountLamports = BigInt(Math.floor(amount * 1e9));
      const destination = new PublicKey(splitDestination.trim());
      const refund = new PublicKey(activeAccount.publicKey);
      const message = quantumSplitMessage(amountLamports, destination.toBytes(), refund.toBytes());

      setStatusMessage("Signing split message with the one-time key...");
      const signature = await wotsSignMessage(message, keyPair.secretKey);

      setStatusMessage("Verifying local Winternitz signature...");
      const valid = await wotsVerifyMessage(message, signature, keyPair.publicKey);

      if (!valid) {
        setStatusMessage("Signature verification failed!");
        return;
      }

      const signatureBytes = serializeWotsSignature(signature);
      setLastProofHex(bytesToHex(signatureBytes).substring(0, 64) + "...");

      await withRpcFallback(network, async (connection) => {
        const ix = createSplitQuantumVaultInstruction(
          new PublicKey(vault.vaultAddress),
          destination,
          refund,
          {
            signature: signatureBytes,
            amount: amountLamports,
            bump: findQuantumVaultPda(keyPair.publicKeyHash)[1],
          },
        );

        const tx = new Transaction().add(ix);
        return signAndSendTransaction(
          connection,
          tx,
          activeAccount.publicKey,
          (msg) => setStatusMessage(msg),
        );
      });

      clearQuantumVaultKey(walletAddress);
      setStatusMessage("Quantum vault split completed and the one-time vault was closed.");
      setSplitAmount("");
      setSplitDestination("");
      setActivePanel("overview");
      await Promise.all([refreshQuantumVault(), refreshBalances(), refreshTransactions()]);
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Close Vault ──────────────────────────────────────────────────

  const handleCloseVault = async () => {
    if (!activeAccount?.publicKey || !vault.vaultAddress) return;

    setIsProcessing(true);
    setStatusMessage("Building close authorization...");

    try {
      const serializedKey = getQuantumVaultKey(walletAddress);
      if (!serializedKey) {
        throw new Error("No local Winternitz key found for this quantum vault.");
      }

      const keyPair = deserializeWotsKeyPair(serializedKey);
      const refund = new PublicKey(activeAccount.publicKey);
      const message = quantumCloseMessage(refund.toBytes());

      setStatusMessage("Signing vault close with the one-time key...");
      const signature = await wotsSignMessage(message, keyPair.secretKey);

      const valid = await wotsVerifyMessage(message, signature, keyPair.publicKey);
      if (!valid) {
        setStatusMessage("Close signature verification failed!");
        return;
      }

      const signatureBytes = serializeWotsSignature(signature);
      setLastProofHex(bytesToHex(signatureBytes).substring(0, 64) + "...");

      await withRpcFallback(network, async (connection) => {
        const ix = createCloseQuantumVaultInstruction(
          new PublicKey(vault.vaultAddress),
          refund,
          {
            signature: signatureBytes,
            bump: findQuantumVaultPda(keyPair.publicKeyHash)[1],
          },
        );

        const tx = new Transaction().add(ix);
        return signAndSendTransaction(
          connection,
          tx,
          activeAccount.publicKey,
          (msg) => setStatusMessage(msg),
        );
      });

      clearQuantumVaultKey(walletAddress);
      setStatusMessage("Quantum vault closed and all funds were returned to your wallet.");
      setActivePanel("overview");
      await Promise.all([refreshQuantumVault(), refreshBalances(), refreshTransactions()]);
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCopyRoot = async () => {
    await navigator.clipboard.writeText(vault.authorityRootHex);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleCopyVaultAddress = async () => {
    if (!vault.vaultAddress) return;
    await navigator.clipboard.writeText(vault.vaultAddress);
    setCopiedAddress(true);
    setTimeout(() => setCopiedAddress(false), 1500);
  };

  const vaultBalanceSol = vault.balanceLamports / LAMPORTS_PER_SOL;
  const explorerClusterParam = network === "mainnet" ? "" : `?cluster=${network}`;
  const quantumVaultExplorerUrl = vault.vaultAddress
    ? `https://explorer.solana.com/address/${vault.vaultAddress}${explorerClusterParam}`
    : null;

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => onNavigate("dashboard")}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold flex-1 text-center mr-8">
          Quantum Vault
        </h2>
      </div>

      {/* Status Banner */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/15 flex items-center justify-center">
              <Atom className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">
                {vault.status === VaultStatus.None && "No Quantum Vault"}
                {vault.status === VaultStatus.Active && "Quantum Vault Active"}
              </p>
              <p className="text-xs text-muted-foreground">
                {vault.status === VaultStatus.None &&
                  "Open a one-time Winternitz vault PDA and fund it like a receive address"}
                {vault.status === VaultStatus.Active &&
                  "This vault can be spent exactly once with its bound Winternitz key"}
              </p>
            </div>
            {vault.status === VaultStatus.Active && (
              <div className="flex items-center gap-1">
                <Shield className="h-4 w-4 text-success" />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <AnimatePresence mode="wait">
        {/* ── No Vault: Open ── */}
        {vault.status === VaultStatus.None && activePanel === "overview" && (
          <motion.div
            key="no-vault"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-4"
          >
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Info className="h-4 w-4 text-primary" />
                  What is a Quantum Vault?
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  A quantum vault uses{" "}
                  <span className="text-foreground font-medium">a Blueshift-style Winternitz one-time signature</span>{" "}
                  to bind a PDA that can hold SOL until you authorize a single split or close.
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  After opening the vault, fund its PDA like a receive address. The
                  first successful split or close consumes the one-time key and
                  closes the vault.
                </p>
                <div className="grid grid-cols-3 gap-2 pt-2">
                  <div className="text-center p-2 rounded-lg bg-muted">
                    <p className="text-lg font-bold text-primary">1</p>
                    <p className="text-[10px] text-muted-foreground">One-time spend</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-muted">
                    <p className="text-lg font-bold text-primary">16</p>
                    <p className="text-[10px] text-muted-foreground">Winternitz chains</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-muted">
                    <p className="text-lg font-bold text-primary">PDA</p>
                    <p className="text-[10px] text-muted-foreground">Program-owned vault</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Button
              className="w-full gap-2"
              size="lg"
              onClick={handleOpenVault}
              disabled={isProcessing}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Opening vault...
                </>
              ) : (
                <>
                  <Unlock className="h-4 w-4" />
                  Initialize Quantum Vault
                </>
              )}
            </Button>
          </motion.div>
        )}

        {/* ── Active Vault: Overview ── */}
        {vault.status === VaultStatus.Active && activePanel === "overview" && (
          <motion.div
            key="active-vault"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-4"
          >
            {/* Authority info */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Vault Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Quantum Vault Address</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-[10px] font-mono bg-muted rounded px-2 py-1.5 truncate">
                      {vault.vaultAddress}
                    </code>
                    <button
                      onClick={handleCopyVaultAddress}
                      className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
                    >
                      {copiedAddress ? (
                        <Check className="h-3 w-3 text-success" />
                      ) : (
                        <Copy className="h-3 w-3 text-muted-foreground" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between mb-1">
                    <p className="text-[10px] text-muted-foreground">Onchain Balance</p>
                    <p className="text-[10px] font-mono text-primary">{vaultBalanceSol.toFixed(9)} SOL</p>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Fund this address from any wallet, then execute exactly one split or close.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2 rounded-lg bg-muted text-center">
                    <p className="text-sm font-bold">{vault.hasLocalKey ? "Loaded" : "Missing"}</p>
                    <p className="text-[10px] text-muted-foreground">Local Winternitz key</p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted text-center">
                    <p className="text-sm font-bold">Single-use</p>
                    <p className="text-[10px] text-muted-foreground">Vault lifecycle</p>
                  </div>
                </div>

                {quantumVaultExplorerUrl && (
                  <a
                    href={quantumVaultExplorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                  >
                    View vault on Explorer <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </CardContent>
            </Card>

            {vault.publicKeyHashHex && (
              <Card>
                <CardContent className="pt-4 pb-4 space-y-2">
                  <p className="text-[10px] text-muted-foreground">Winternitz Public Key Hash</p>
                  <code className="text-[10px] font-mono text-muted-foreground break-all">
                    {vault.publicKeyHashHex}
                  </code>
                </CardContent>
              </Card>
            )}

            {(vault.authorityRootHex || vault.authorityNextLeafIndex !== null) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Quantum Authority Status</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    This separate onchain account tracks the post-quantum authority state for
                    Vaulkyrie admin actions.
                  </p>
                  {vault.authorityRootHex && (
                    <div>
                      <p className="text-[10px] text-muted-foreground mb-1">Current Authority Root</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-[10px] font-mono bg-muted rounded px-2 py-1.5 truncate">
                          {vault.authorityRootHex}
                        </code>
                        <button
                          onClick={handleCopyRoot}
                          className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
                        >
                          {copied ? (
                            <Check className="h-3 w-3 text-success" />
                          ) : (
                            <Copy className="h-3 w-3 text-muted-foreground" />
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2 rounded-lg bg-muted text-center">
                      <p className="text-sm font-bold">
                        {vault.hasWinterAuthorityState ? "Winter" : "XMSS"}
                      </p>
                      <p className="text-[10px] text-muted-foreground">Authority mode</p>
                    </div>
                    <div className="p-2 rounded-lg bg-muted text-center">
                      <p className="text-sm font-bold">
                        {vault.authorityNextSequence?.toString() ?? "0"}
                      </p>
                      <p className="text-[10px] text-muted-foreground">Authority sequence</p>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {vault.hasWinterAuthorityState
                      ? "Local Winter signer state is loaded. Authority advances roll to a fresh root after each high-risk admin authorization."
                      : `Legacy XMSS authority tree. Next leaf: ${vault.authorityNextLeafIndex ?? 0}.`}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Last proof */}
            {lastProofHex && (
              <Card>
                <CardContent className="pt-4 pb-4">
                  <p className="text-[10px] text-muted-foreground mb-1">Last Proof</p>
                  <code className="text-[10px] font-mono text-muted-foreground break-all">
                    {lastProofHex}
                  </code>
                </CardContent>
              </Card>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                className="w-full gap-2"
                onClick={() => setActivePanel("split")}
                disabled={!vault.hasLocalKey}
              >
                <ArrowRight className="h-4 w-4" />
                Split Vault Once
              </Button>

              <Button
                variant="secondary"
                className="w-full gap-2 text-destructive hover:text-destructive"
                onClick={() => setActivePanel("close")}
                disabled={!vault.hasLocalKey}
              >
                <Lock className="h-4 w-4" />
                Close Vault
              </Button>
            </div>
          </motion.div>
        )}

        {/* ── Split Panel ── */}
        {activePanel === "split" && (
          <motion.div
            key="split"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-4"
          >
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Split Vault</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Partially withdraw from the onchain quantum vault. This consumes
                  the one-time Winternitz authorization and closes the vault PDA.
                </p>

                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Amount (SOL)</label>
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={splitAmount}
                    onChange={(e) => setSplitAmount(e.target.value)}
                    className="font-mono"
                    step="0.001"
                    min="0"
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Destination Address
                  </label>
                  <Input
                    placeholder="Solana address (base58)"
                    value={splitDestination}
                    onChange={(e) => setSplitDestination(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <AlertTriangle className="h-3 w-3" />
                  One-time authorization — the vault PDA is destroyed after the split
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => setActivePanel("overview")}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 gap-2"
                onClick={handleSplitVault}
                disabled={isProcessing}
              >
                {isProcessing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Shield className="h-4 w-4" />
                )}
                Sign & Split
              </Button>
            </div>
          </motion.div>
        )}

        {/* ── Close Panel ── */}
        {activePanel === "close" && (
          <motion.div
            key="close"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col gap-4"
          >
            <Card className="border-destructive/30">
              <CardHeader>
                <CardTitle className="text-sm text-destructive flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Close Quantum Vault
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  This will withdraw <strong>all</strong> funds from the quantum
                  vault and destroy the one-time vault PDA. This action is irreversible.
                </p>
                <p className="text-xs text-muted-foreground">
                  All remaining funds will be sent to your wallet address:
                </p>
                <code className="text-[10px] font-mono bg-muted rounded px-2 py-1.5 block truncate">
                  {walletAddress}
                </code>
                <div className="flex items-center gap-2 text-[10px] text-warning">
                  <AlertTriangle className="h-3 w-3" />
                  This consumes the one-time Winternitz key
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => setActivePanel("overview")}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="flex-1 gap-2"
                onClick={handleCloseVault}
                disabled={isProcessing}
              >
                {isProcessing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Lock className="h-4 w-4" />
                )}
                Close Vault
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Status message */}
      {statusMessage && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-xs text-center text-muted-foreground px-2"
        >
          {statusMessage}
        </motion.p>
      )}
    </div>
  );
}
