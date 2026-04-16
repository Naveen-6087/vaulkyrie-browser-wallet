import { useState } from "react";
import { ArrowUpRight, AlertCircle, Loader2, Check, ExternalLink } from "lucide-react";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { signLocal, hexToBytes } from "@/services/frost/frostService";
import { useWalletStore } from "@/store/walletStore";
import { createConnection } from "@/services/solanaRpc";
import type { WalletView } from "@/types";

interface SendViewProps {
  balance: number;
  onNavigate: (view: WalletView) => void;
}

type SendPhase = "form" | "review" | "signing" | "success" | "error";

export function SendView({ balance, onNavigate }: SendViewProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<SendPhase>("form");
  const [signingMessage, setSigningMessage] = useState("");
  const [txSignature, setTxSignature] = useState("");
  const { activeAccount, network } = useWalletStore();

  const solBalance = balance;
  const parsedAmount = parseFloat(amount) || 0;
  const isValid =
    recipient.length >= 32 && parsedAmount > 0 && parsedAmount <= solBalance;

  const handleMax = () => {
    const maxSend = Math.max(0, solBalance - 0.005);
    setAmount(maxSend.toFixed(4));
  };

  const handleReview = () => {
    if (!isValid) {
      setError("Invalid recipient or amount");
      return;
    }
    try {
      new PublicKey(recipient);
    } catch {
      setError("Invalid Solana address");
      return;
    }
    setPhase("review");
  };

  const handleSign = async () => {
    setPhase("signing");
    setSigningMessage("Loading DKG key packages...");

    try {
      // Load DKG result from persistent store, fallback to sessionStorage for migration
      const pubKey = activeAccount?.publicKey ?? "";
      const { getDkgResult, storeDkgResult: persistDkg } = useWalletStore.getState();
      let dkg = getDkgResult(pubKey);

      if (!dkg) {
        const dkgJson = sessionStorage.getItem("vaulkyrie_dkg_result");
        if (dkgJson) {
          const parsed = JSON.parse(dkgJson);
          dkg = {
            groupPublicKeyHex: parsed.groupPublicKeyHex ?? "",
            publicKeyPackage: parsed.publicKeyPackage ?? "",
            keyPackages: parsed.keyPackages ?? {},
            threshold: parsed.threshold ?? 2,
            participants: parsed.participants ?? 3,
            createdAt: Date.now(),
          };
          persistDkg(pubKey, dkg);
          sessionStorage.removeItem("vaulkyrie_dkg_result");
        }
      }

      if (!dkg) {
        throw new Error("No DKG key packages found. Run DKG ceremony first.");
      }

      // Build the Solana transfer transaction
      setSigningMessage("Building transaction...");
      const connection = createConnection(network);
      const fromPubkey = new PublicKey(activeAccount!.publicKey);
      const toPubkey = new PublicKey(recipient);

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey,
          toPubkey,
          lamports: Math.floor(parsedAmount * LAMPORTS_PER_SOL),
        }),
      );

      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = fromPubkey;

      // Serialize the message for FROST signing
      const messageBytes = tx.serializeMessage();

      // Select signers (use first `threshold` participants)
      setSigningMessage(`Running FROST threshold signing (${dkg.threshold}-of-${dkg.participants})...`);
      const signerIds = Array.from({ length: dkg.threshold }, (_, i) => i + 1);

      const { signatureHex, verified } = await signLocal(
        messageBytes,
        dkg.keyPackages,
        dkg.publicKeyPackage,
        signerIds,
      );

      if (!verified) {
        throw new Error("FROST signature verification failed");
      }

      setSigningMessage("Signature verified! Submitting to Solana...");

      // Attach the signature to the transaction
      const sigBytes = hexToBytes(signatureHex);
      tx.addSignature(fromPubkey, Buffer.from(sigBytes));

      // Send the raw signed transaction
      const rawTx = tx.serialize();
      const signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      setTxSignature(signature);
      setPhase("success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setPhase("error");
    }
  };

  const explorerUrl = txSignature
    ? `https://explorer.solana.com/tx/${txSignature}?cluster=${network}`
    : "";

  // ── Render ───────────────────────────────────────────────────────

  if (phase === "signing") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1 items-center justify-center">
        <div className="relative mb-4">
          <div className="absolute -inset-4 bg-primary/20 rounded-full blur-xl" />
          <div className="relative h-16 w-16 rounded-full bg-primary/15 border-2 border-primary/40 flex items-center justify-center">
            <Loader2 className="h-8 w-8 text-primary animate-spin" />
          </div>
        </div>
        <h3 className="text-base font-semibold">Threshold Signing</h3>
        <p className="text-xs text-muted-foreground text-center px-8">
          {signingMessage}
        </p>
      </div>
    );
  }

  if (phase === "success") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1 items-center justify-center">
        <div className="relative mb-4">
          <div className="absolute -inset-4 bg-success/20 rounded-full blur-xl" />
          <div className="relative h-16 w-16 rounded-full bg-success/15 border-2 border-success/40 flex items-center justify-center">
            <Check className="h-8 w-8 text-success" />
          </div>
        </div>
        <h3 className="text-base font-semibold">Transaction Sent!</h3>
        <p className="text-xs text-muted-foreground text-center">
          {parsedAmount} SOL sent to {recipient.substring(0, 8)}...
        </p>
        {txSignature && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-primary hover:underline mt-2"
          >
            View on Explorer
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <Button
          className="w-full mt-6"
          onClick={() => onNavigate("dashboard")}
        >
          Back to Dashboard
        </Button>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1">
        <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-medium text-destructive">Transaction Failed</p>
            <p className="text-[10px] text-destructive/80 mt-0.5">{error}</p>
          </div>
        </div>
        <Button variant="secondary" onClick={() => { setPhase("form"); setError(""); }}>
          Try Again
        </Button>
        <Button variant="secondary" onClick={() => onNavigate("dashboard")}>
          Back to Dashboard
        </Button>
      </div>
    );
  }

  if (phase === "review") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setPhase("form")}
            className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
          >
            ← Back
          </button>
          <h2 className="text-lg font-semibold flex-1 text-center mr-8">Review</h2>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">Amount</span>
              <span className="text-sm font-bold">{parsedAmount} SOL</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">To</span>
              <span className="text-xs font-mono truncate max-w-[180px]">{recipient}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">Network fee</span>
              <span className="text-xs text-muted-foreground">~0.000005 SOL</span>
            </div>
            <div className="border-t border-border pt-2 flex justify-between">
              <span className="text-xs font-medium">Total</span>
              <span className="text-sm font-bold">{(parsedAmount + 0.000005).toFixed(6)} SOL</span>
            </div>
          </CardContent>
        </Card>

        <p className="text-[10px] text-muted-foreground text-center">
          Signing via FROST {useWalletStore.getState().vaultState?.threshold ?? 2}-of-{useWalletStore.getState().vaultState?.participants ?? 3} threshold ceremony
        </p>

        <div className="mt-auto">
          <Button className="w-full gap-2" size="lg" onClick={handleSign}>
            <ArrowUpRight className="h-4 w-4" />
            Confirm & Sign
          </Button>
        </div>
      </div>
    );
  }

  // ── Form Phase ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 p-4 flex-1">
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => onNavigate("dashboard")}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold flex-1 text-center mr-8">Send SOL</h2>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recipient</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            placeholder="Solana address (base58)"
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              setError("");
            }}
            className="font-mono text-xs"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Amount</CardTitle>
            <button
              onClick={handleMax}
              className="text-xs text-primary hover:text-primary/80 font-medium cursor-pointer"
            >
              MAX
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <Input
              type="number"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError("");
              }}
              className="font-mono text-lg pr-14"
              step="0.0001"
              min="0"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">
              SOL
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Available: {solBalance.toFixed(4)} SOL
          </p>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-center gap-2 text-destructive text-xs px-1">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      <div className="mt-auto">
        <Button
          className="w-full gap-2"
          size="lg"
          disabled={!isValid}
          onClick={handleReview}
        >
          <ArrowUpRight className="h-4 w-4" />
          Review transaction
        </Button>
        <p className="text-[10px] text-muted-foreground text-center mt-2">
          Threshold signing via Vaulkyrie FROST protocol
        </p>
      </div>
    </div>
  );
}
