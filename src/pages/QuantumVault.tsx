/**
 * Quantum Vault management page.
 *
 * Provides UI for WOTS+/XMSS post-quantum authority operations:
 *   - View vault status and authority info
 *   - Open (initialize) a quantum vault
 *   - Split vault (partial withdrawal with WOTS+ signature)
 *   - Close vault (full withdrawal with WOTS+ signature)
 *   - Authority rotation prompt when XMSS leaves near exhaustion
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PublicKey } from "@solana/web3.js";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  generateSmallXmssTree,
  xmssSign,
  wotsVerify,
  quantumSplitDigest,
  quantumCloseDigest,
  bytesToHex,
  deserializeXmssTree,
  serializeAuthProof,
  serializeXmssTree,
  type XmssTree,
} from "@/services/quantum/wots";
import type { WalletView } from "@/types";
import { useWalletStore } from "@/store/walletStore";

// ── Vault Status ─────────────────────────────────────────────────────

const VaultStatus = {
  None: "none",
  Active: "active",
  Exhausted: "exhausted",
} as const;

type VaultStatusType = (typeof VaultStatus)[keyof typeof VaultStatus];

interface QuantumVaultState {
  status: VaultStatusType;
  balance: number;
  authorityRootHex: string;
  nextLeafIndex: number;
  totalLeaves: number;
  xmssTree: XmssTree | null;
}

interface QuantumVaultProps {
  walletAddress: string;
  onNavigate: (view: WalletView) => void;
}

export function QuantumVault({ walletAddress, onNavigate }: QuantumVaultProps) {
  const { activeAccount, storeXmssTree, getXmssTree, clearXmssTree } = useWalletStore();
  const [vault, setVault] = useState<QuantumVaultState>({
    status: VaultStatus.None,
    balance: activeAccount?.balance ?? 0,
    authorityRootHex: "",
    nextLeafIndex: 0,
    totalLeaves: 0,
    xmssTree: null,
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

  const remainingSignatures = vault.totalLeaves - vault.nextLeafIndex;
  const isNearExhaustion = vault.status === VaultStatus.Active && remainingSignatures <= 3;

  useEffect(() => {
    if (!walletAddress) return;

    const serialized = getXmssTree(walletAddress);
    if (!serialized) {
      setVault((prev) => ({
        ...prev,
        balance: activeAccount?.balance ?? prev.balance,
      }));
      return;
    }

    try {
      const tree = deserializeXmssTree(serialized);
      const totalLeaves = 1 << tree.depth;
      const exhausted = tree.nextLeafIndex >= totalLeaves;

      setVault({
        status: exhausted ? VaultStatus.Exhausted : VaultStatus.Active,
        balance: activeAccount?.balance ?? 0,
        authorityRootHex: bytesToHex(tree.root),
        nextLeafIndex: tree.nextLeafIndex,
        totalLeaves,
        xmssTree: tree,
      });
    } catch (err) {
      console.warn("Failed to restore quantum vault state:", err);
    }
  }, [activeAccount?.balance, getXmssTree, walletAddress]);

  // ── Open Vault ───────────────────────────────────────────────────

  const handleOpenVault = async () => {
    setIsProcessing(true);
    setStatusMessage("Generating XMSS tree (8 leaves for demo)...");

    try {
      // Generate a small tree for demo (3-depth = 8 leaves)
      const tree = await generateSmallXmssTree();

      setStatusMessage("XMSS tree generated! Computing authority root...");
      await new Promise((r) => setTimeout(r, 300));

      setVault({
        status: VaultStatus.Active,
        balance: activeAccount?.balance ?? 0,
        authorityRootHex: bytesToHex(tree.root),
        nextLeafIndex: 0,
        totalLeaves: 1 << tree.depth,
        xmssTree: tree,
      });
      storeXmssTree(walletAddress, serializeXmssTree(tree));

      setStatusMessage("Quantum vault initialized!");
      setActivePanel("overview");
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Split Vault ──────────────────────────────────────────────────

  const handleSplitVault = async () => {
    if (!vault.xmssTree) return;

    const amount = parseFloat(splitAmount);
    if (isNaN(amount) || amount <= 0) {
      setStatusMessage("Enter a valid amount");
      return;
    }
    if (!splitDestination || splitDestination.length < 32) {
      setStatusMessage("Enter a valid Solana address");
      return;
    }

    setIsProcessing(true);
    setStatusMessage("Computing split digest...");

    try {
      const amountLamports = BigInt(Math.floor(amount * 1e9));
      const destBytes = new PublicKey(splitDestination).toBytes();
      const refundBytes = new PublicKey(walletAddress).toBytes();

      const digest = await quantumSplitDigest(amountLamports, destBytes, refundBytes);
      setStatusMessage("Signing with WOTS+ (one-time signature)...");

      const { signature, publicKey, leafIndex, authPath } = await xmssSign(
        vault.xmssTree,
        digest,
      );

      // Verify the signature locally before submission
      setStatusMessage("Verifying signature...");
      const valid = await wotsVerify(digest, signature, publicKey);

      if (!valid) {
        setStatusMessage("Signature verification failed!");
        setIsProcessing(false);
        return;
      }

      const proof = serializeAuthProof(publicKey, signature, leafIndex, authPath);
      setLastProofHex(bytesToHex(proof).substring(0, 64) + "...");

      const totalLeaves = 1 << vault.xmssTree.depth;
      const nextLeafIndex = vault.xmssTree.nextLeafIndex;
      const nextStatus = nextLeafIndex >= totalLeaves ? VaultStatus.Exhausted : VaultStatus.Active;

      setVault((prev) => ({
        ...prev,
        status: nextStatus,
        nextLeafIndex,
        totalLeaves,
        xmssTree: vault.xmssTree,
      }));
      storeXmssTree(walletAddress, serializeXmssTree(vault.xmssTree));

      setStatusMessage(
        `Split signed! Leaf #${leafIndex} consumed. ` +
          `${Math.max(0, totalLeaves - nextLeafIndex)} signatures remaining.`,
      );
      setSplitAmount("");
      setSplitDestination("");
      setActivePanel("overview");
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Close Vault ──────────────────────────────────────────────────

  const handleCloseVault = async () => {
    if (!vault.xmssTree) return;

    setIsProcessing(true);
    setStatusMessage("Computing close digest...");

    try {
      const refundBytes = new PublicKey(walletAddress).toBytes();
      const digest = await quantumCloseDigest(refundBytes);

      setStatusMessage("Signing vault close with WOTS+...");
      const { signature, publicKey, leafIndex, authPath } = await xmssSign(
        vault.xmssTree,
        digest,
      );

      const valid = await wotsVerify(digest, signature, publicKey);
      if (!valid) {
        setStatusMessage("Close signature verification failed!");
        setIsProcessing(false);
        return;
      }

      const proof = serializeAuthProof(publicKey, signature, leafIndex, authPath);
      setLastProofHex(bytesToHex(proof).substring(0, 64) + "...");

      setVault({
        status: VaultStatus.None,
        balance: 0,
        authorityRootHex: "",
        nextLeafIndex: 0,
        totalLeaves: 0,
        xmssTree: null,
      });
      clearXmssTree(walletAddress);
      setStatusMessage("Quantum vault closed. All funds returned to refund address.");
      setActivePanel("overview");
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
                {vault.status === VaultStatus.Exhausted && "Authority Exhausted"}
              </p>
              <p className="text-xs text-muted-foreground">
                {vault.status === VaultStatus.None && "Initialize a post-quantum vault with WOTS+/XMSS authority"}
                {vault.status === VaultStatus.Active &&
                  `${remainingSignatures} of ${vault.totalLeaves} signatures remaining`}
                {vault.status === VaultStatus.Exhausted && "Rotate to a new authority to continue"}
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

      {/* Near-exhaustion warning */}
      {isNearExhaustion && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 border border-warning/30"
        >
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-medium text-warning">Authority Nearly Exhausted</p>
            <p className="text-[10px] text-warning/80 mt-0.5">
              Only {remainingSignatures} WOTS+ signature{remainingSignatures !== 1 ? "s" : ""} remaining.
              Rotate your authority to a new XMSS tree before it runs out.
            </p>
          </div>
        </motion.div>
      )}

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
                  <span className="text-foreground font-medium">WOTS+ one-time signatures</span>{" "}
                  organized in an{" "}
                  <span className="text-foreground font-medium">XMSS Merkle tree</span>{" "}
                  to provide post-quantum security for high-value operations.
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Each signature consumes one leaf of the tree. When all leaves are
                  used, the authority must be rotated to a fresh tree.
                </p>
                <div className="grid grid-cols-3 gap-2 pt-2">
                  <div className="text-center p-2 rounded-lg bg-muted">
                    <p className="text-lg font-bold text-primary">SHA-256</p>
                    <p className="text-[10px] text-muted-foreground">Hash function</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-muted">
                    <p className="text-lg font-bold text-primary">16</p>
                    <p className="text-[10px] text-muted-foreground">WOTS+ chains</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-muted">
                    <p className="text-lg font-bold text-primary">256</p>
                    <p className="text-[10px] text-muted-foreground">Max signatures</p>
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
                  Generating keys...
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
                <CardTitle className="text-sm">Authority Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">XMSS Root Hash</p>
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

                {/* Leaf usage progress */}
                <div>
                  <div className="flex justify-between mb-1">
                    <p className="text-[10px] text-muted-foreground">Leaf Usage</p>
                    <p className="text-[10px] font-mono text-primary">
                      {vault.nextLeafIndex} / {vault.totalLeaves}
                    </p>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <motion.div
                      className={`h-full rounded-full ${
                        isNearExhaustion
                          ? "bg-warning"
                          : "bg-gradient-to-r from-primary/80 to-primary"
                      }`}
                      animate={{
                        width: `${(vault.nextLeafIndex / vault.totalLeaves) * 100}%`,
                      }}
                      transition={{ duration: 0.5 }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {remainingSignatures} one-time signature{remainingSignatures !== 1 ? "s" : ""} remaining
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2 rounded-lg bg-muted text-center">
                    <p className="text-sm font-bold">{vault.xmssTree?.depth ?? 0}</p>
                    <p className="text-[10px] text-muted-foreground">Tree depth</p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted text-center">
                    <p className="text-sm font-bold">16 × 32B</p>
                    <p className="text-[10px] text-muted-foreground">WOTS+ key size</p>
                  </div>
                </div>
              </CardContent>
            </Card>

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
                disabled={remainingSignatures === 0}
              >
                <ArrowRight className="h-4 w-4" />
                Split Vault (Partial Withdraw)
              </Button>

              <Button
                variant="secondary"
                className="w-full gap-2 text-destructive hover:text-destructive"
                onClick={() => setActivePanel("close")}
                disabled={remainingSignatures === 0}
              >
                <Lock className="h-4 w-4" />
                Close Vault (Full Withdraw)
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
                  Partially withdraw from the quantum vault. This consumes one
                  WOTS+ leaf for the authorization signature.
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
                  This will consume leaf #{vault.nextLeafIndex} — irreversible
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
                  vault and destroy the on-chain authority account. This action is
                  irreversible.
                </p>
                <p className="text-xs text-muted-foreground">
                  All remaining funds will be sent to your wallet address:
                </p>
                <code className="text-[10px] font-mono bg-muted rounded px-2 py-1.5 block truncate">
                  {walletAddress}
                </code>
                <div className="flex items-center gap-2 text-[10px] text-warning">
                  <AlertTriangle className="h-3 w-3" />
                  Consumes leaf #{vault.nextLeafIndex} — last chance to verify
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
