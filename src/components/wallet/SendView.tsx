import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ArrowUpRight, AlertCircle, Loader2, Check, ExternalLink, Users, ChevronDown, Radio } from "lucide-react";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { signLocal, hexToBytes, bytesToHex } from "@/services/frost/frostService";
import { SigningOrchestrator } from "@/services/frost/signingOrchestrator";
import { requestCosignerSignature, type VaultCosignerMetadata } from "@/services/cosigner/cosignerClient";
import {
  createRelay,
  generateSessionCode,
  parseSessionInvite,
  probeRelayAvailability,
  resolveRelayUrl,
  type RelayAdapter,
} from "@/services/relay/relayAdapter";
import type { SignRequestPayload } from "@/services/relay/channelRelay";
import { createRelaySessionMetadata } from "@/services/relay/sessionInvite";
import { useWalletStore } from "@/store/walletStore";
import { createConnection, SOL_ICON } from "@/services/solanaRpc";
import { buildSplTransferTransaction } from "@/services/splToken";
import {
  deserializeXmssTree,
  generateXmssTree,
  getInitialXmssAuthorityHash,
  serializeXmssTree,
} from "@/services/quantum/wots";
import {
  createWinterAuthoritySignerState,
  deserializeWinterAuthoritySignerState,
  serializeWinterAuthoritySignerState,
} from "@/services/quantum/winterAuthority";
import { shortenAddress } from "@/lib/utils";
import type { WalletView, Token } from "@/types";
import { VaulkyrieClient } from "@/sdk/client";
import { PolicyMxeClient } from "@/sdk/policyClient";
import {
  createCommitSpendOrchestrationInstruction,
  createCompleteSpendOrchestrationInstruction,
  createInitAuthorityInstruction,
  createInitSpendOrchestrationInstruction,
  createInitVaultInstruction,
} from "@/sdk/instructions";
import { PolicyEvaluationStatus, VAULKYRIE_POLICY_MXE_PROGRAM_ID } from "@/sdk/constants";
import { findQuantumAuthorityPda, findSpendOrchestrationPda, findVaultRegistryPda } from "@/sdk/pda";
import {
  buildSpendActionHash,
  buildSpendOrchestrationBindings,
  generateSpendSessionNonce,
} from "@/sdk/spendBindings";
import {
  buildWalletPolicyActionHash,
  buildWalletPolicyActionPayload,
} from "@/sdk/policyBindings";
import {
  analyzeLegacyTransaction,
  type TransactionAnalysis,
} from "@/services/transactionAnalysis";

interface SendViewProps {
  balance: number;
  onNavigate: (view: WalletView) => void;
}

type SendPhase = "form" | "review" | "join-review" | "signing" | "coordinate" | "success" | "error";
type SendMode = "send" | "join";

type BufferedSigningMessage =
  | { type: "round1"; fromId: number; commitments: number[] }
  | { type: "round2"; fromId: number; share: number[] };

type ReviewAnalysisState =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: TransactionAnalysis }
  | { status: "error"; error: string };

interface PreparedPolicySnapshot {
  evaluationAddress: string;
  receiptCommitment: string;
  decisionCommitment: string;
  reasonCode: number;
  delayUntilSlot: string;
}

interface PreparedSpendActivityContext {
  actionHash: string;
  orchestrationAddress: string;
  policy: PreparedPolicySnapshot | null;
}

// ── Custom token dropdown with icons ────────────────────────────────
function TokenDropdown({
  selectedToken,
  balance,
  tokens,
  onSelect,
}: {
  selectedToken: string;
  balance: number;
  tokens: Token[];
  onSelect: (symbol: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const solToken: Token = {
    symbol: "SOL",
    name: "Solana",
    balance,
    decimals: 9,
    icon: SOL_ICON,
  };

  const allTokens = [solToken, ...tokens.filter((t) => t.symbol !== "SOL" && t.balance > 0)];
  const current = allTokens.find((t) => t.symbol === selectedToken) ?? solToken;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-3 w-full px-4 py-3 rounded-xl bg-card border border-border hover:border-primary/40 transition-colors cursor-pointer"
      >
        <TokenIconSmall symbol={current.symbol} icon={current.icon} />
        <div className="flex-1 text-left min-w-0">
          <p className="text-sm font-semibold">{current.symbol}</p>
          <p className="text-[11px] text-muted-foreground">{current.name}</p>
        </div>
        <span className="text-xs text-muted-foreground font-mono mr-1">
          {current.balance.toFixed(4)}
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 rounded-xl border border-border bg-card shadow-lg overflow-hidden max-h-52 overflow-y-auto">
          {allTokens.map((t) => (
            <button
              key={t.mint ?? t.symbol}
              type="button"
              onClick={() => { onSelect(t.symbol); setOpen(false); }}
              className={`flex items-center gap-3 w-full px-4 py-2.5 hover:bg-accent/60 transition-colors cursor-pointer
                ${t.symbol === selectedToken ? "bg-accent/40" : ""}`}
            >
              <TokenIconSmall symbol={t.symbol} icon={t.icon} />
              <div className="flex-1 text-left min-w-0">
                <p className="text-sm font-medium">{t.symbol}</p>
                <p className="text-[10px] text-muted-foreground">{t.name}</p>
              </div>
              <span className="text-xs font-mono text-muted-foreground">
                {t.balance.toFixed(4)}
              </span>
              {t.symbol === selectedToken && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TokenIconSmall({ symbol, icon }: { symbol: string; icon?: string }) {
  const [failed, setFailed] = useState(false);
  const hue = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  if (icon && !failed) {
    return <img src={icon} alt={symbol} className="h-7 w-7 rounded-full object-cover shrink-0" onError={() => setFailed(true)} />;
  }
  return (
    <div
      className="h-7 w-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
      style={{ background: `linear-gradient(135deg, oklch(0.60 0.15 ${hue}), oklch(0.45 0.12 ${hue + 30}))` }}
    >
      {symbol.slice(0, 2)}
    </div>
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

async function canReachRelay(url: string): Promise<boolean> {
  try {
    return await probeRelayAvailability(resolveRelayUrl(url), 1500);
  } catch {
    return false;
  }
}

function crossDeviceRelayUnavailableMessage(): string {
  return "Cross-device relay is unavailable right now. Check your internet connection, then try again. Advanced users can switch to a self-hosted relay in Settings > Cross-device Relay.";
}

function buildPreviewSignerIds(
  threshold: number,
  participants: number,
  availableKeyIds: number[],
  preferredId?: number,
): number[] {
  const signerIds: number[] = [];
  const pushSigner = (candidate: number | undefined) => {
    if (!candidate || signerIds.includes(candidate)) return;
    signerIds.push(candidate);
  };

  pushSigner(preferredId);
  availableKeyIds
    .slice()
    .sort((left, right) => left - right)
    .forEach(pushSigner);

  for (let candidate = 1; signerIds.length < threshold && candidate <= Math.max(participants, threshold); candidate += 1) {
    pushSigner(candidate);
  }

  return signerIds.slice(0, threshold);
}

function formatFeeLabel(lamports: number | null): string {
  if (lamports === null) return "Unavailable";
  return `~${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}

export function SendView({ balance, onNavigate }: SendViewProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<SendPhase>("form");
  const [mode, setMode] = useState<SendMode>("send");
  const [signingMessage, setSigningMessage] = useState("");
  const [txSignature, setTxSignature] = useState("");
  const [orchestrationAddress, setOrchestrationAddress] = useState("");
  const [signingSessionCode, setSigningSessionCode] = useState("");
  const [relaySessionInfo, setRelaySessionInfo] = useState(() => createRelaySessionMetadata("------"));
  const [joinSessionCode, setJoinSessionCode] = useState("");
  const [pendingSignRequest, setPendingSignRequest] = useState<SignRequestPayload | null>(null);
  const [reviewAnalysis, setReviewAnalysis] = useState<ReviewAnalysisState>({ status: "idle" });
  const [selectedToken, setSelectedToken] = useState("SOL");
  const [selectedPolicyProfileId, setSelectedPolicyProfileId] = useState("");
  const [showContacts, setShowContacts] = useState(false);
  const {
    activeAccount,
    network,
    relayUrl,
    tokens,
    contacts,
    policyProfiles,
    pendingPolicyRequest,
    setPendingPolicyRequest,
    getXmssTree,
    storeXmssTree,
    getWinterAuthorityState,
    storeWinterAuthorityState,
    refreshBalances,
    refreshTransactions,
    refreshVaultState,
    recordOrchestrationActivity,
  } = useWalletStore();
  const relayRef = useRef<RelayAdapter | null>(null);
  const orchestratorRef = useRef<SigningOrchestrator | null>(null);
  const pendingSigningMessagesRef = useRef<BufferedSigningMessage[]>([]);
  const signingTimeoutRef = useRef<number | null>(null);

  const selectedTokenInfo = selectedToken === "SOL"
    ? { symbol: "SOL", balance: balance, decimals: 9, mint: undefined }
    : tokens.find((t) => t.symbol === selectedToken) ?? { symbol: selectedToken, balance: 0, decimals: 9, mint: undefined };
  const tokenBalance = selectedTokenInfo.balance;
  const parsedAmount = parseFloat(amount) || 0;
  const parsedJoinSession = parseSessionInvite(joinSessionCode);
  const isValid =
    recipient.length >= 32 && parsedAmount > 0 && parsedAmount <= tokenBalance;
  const savedPolicyProfiles = useMemo(
    () => (activeAccount?.publicKey
      ? (policyProfiles[activeAccount.publicKey] ?? []).filter((profile) => profile.actionType === "send")
      : []),
    [activeAccount?.publicKey, policyProfiles],
  );
  const selectedPolicyProfile = savedPolicyProfiles.find((profile) => profile.id === selectedPolicyProfileId) ?? null;
  const policyMismatch = useMemo(() => {
    if (!selectedPolicyProfile) return null;
    if (selectedPolicyProfile.tokenSymbol !== selectedToken) {
      return `Policy ${selectedPolicyProfile.name} only covers ${selectedPolicyProfile.tokenSymbol} transfers.`;
    }
    if (
      selectedPolicyProfile.maxAmount !== null &&
      parsedAmount > selectedPolicyProfile.maxAmount
    ) {
      return `This transfer exceeds the ${selectedPolicyProfile.maxAmount} ${selectedPolicyProfile.tokenSymbol} limit in ${selectedPolicyProfile.name}.`;
    }
    if (
      selectedPolicyProfile.allowedRecipients.length > 0 &&
      recipient.trim().length > 0 &&
      !selectedPolicyProfile.allowedRecipients.some(
        (allowed) => allowed.toLowerCase() === recipient.trim().toLowerCase(),
      )
    ) {
      return `Recipient is not in the allowlist for ${selectedPolicyProfile.name}.`;
    }
    return null;
  }, [selectedPolicyProfile, selectedToken, parsedAmount, recipient]);
  const needsPolicyReview = selectedPolicyProfile?.approvalMode === "review" && !policyMismatch;
  const blockedByPolicy = selectedPolicyProfile?.approvalMode === "block" && !policyMismatch;

  const matchingContacts = contacts.filter(
    (c) =>
      recipient.length > 0 &&
      (c.name.toLowerCase().includes(recipient.toLowerCase()) ||
        c.address.toLowerCase().startsWith(recipient.toLowerCase()))
  );

  const handleMax = () => {
    const maxSend = selectedToken === "SOL"
      ? Math.max(0, tokenBalance - 0.005)
      : tokenBalance;
    setAmount(maxSend.toFixed(4));
  };

  const clearSigningTimeout = useCallback(() => {
    if (signingTimeoutRef.current !== null) {
      window.clearTimeout(signingTimeoutRef.current);
      signingTimeoutRef.current = null;
    }
  }, []);

  const cleanupRelayState = useCallback((resetSharedState = false) => {
    clearSigningTimeout();
    relayRef.current?.disconnect();
    relayRef.current = null;
    orchestratorRef.current = null;
    pendingSigningMessagesRef.current = [];
    if (resetSharedState) {
      setSigningSessionCode("");
      setPendingSignRequest(null);
      setJoinSessionCode("");
    }
  }, [clearSigningTimeout]);

  useEffect(() => () => cleanupRelayState(), [cleanupRelayState]);

  const queueOrHandleSigningMessage = useCallback((message: BufferedSigningMessage) => {
    const orchestrator = orchestratorRef.current;
    if (!orchestrator) {
      pendingSigningMessagesRef.current.push(message);
      return;
    }

    if (message.type === "round1") {
      orchestrator.handleSignRound1(message.fromId, message.commitments);
      return;
    }

    orchestrator.handleSignRound2(message.fromId, message.share);
  }, []);

  const runSigningOrchestrator = useCallback(async (params: {
    relay: RelayAdapter;
    participantId: number;
    keyPackageJson: string;
    publicKeyPackageJson: string;
    message: Uint8Array;
    signerIds: number[];
    onStatus: (message: string) => void;
  }) => {
    const orchestrator = new SigningOrchestrator({
      relay: params.relay,
      participantId: params.participantId,
      keyPackageJson: params.keyPackageJson,
      publicKeyPackageJson: params.publicKeyPackageJson,
      message: params.message,
      signerIds: params.signerIds,
      onProgress: (progress) => params.onStatus(progress.message),
    });
    orchestratorRef.current = orchestrator;

    const bufferedMessages = pendingSigningMessagesRef.current.splice(0);
    for (const buffered of bufferedMessages) {
      if (buffered.type === "round1") {
        orchestrator.handleSignRound1(buffered.fromId, buffered.commitments);
      } else {
        orchestrator.handleSignRound2(buffered.fromId, buffered.share);
      }
    }

    return orchestrator.run();
  }, []);

  const loadDkgState = useCallback(() => {
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
          participantId: parsed.participantId,
          isMultiDevice: parsed.isMultiDevice,
          cosigner: parsed.cosigner ?? null,
          createdAt: Date.now(),
        };
        persistDkg(pubKey, dkg);
        sessionStorage.removeItem("vaulkyrie_dkg_result");
      }
    }

    return dkg;
  }, [activeAccount?.publicKey]);

  const resetToForm = useCallback((nextMode: SendMode = "send") => {
    cleanupRelayState(true);
    setMode(nextMode);
    setPhase("form");
    setError("");
    setSigningMessage("");
    setTxSignature("");
    setOrchestrationAddress("");
    setRelaySessionInfo(createRelaySessionMetadata("------"));
  }, [cleanupRelayState]);

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
    if (policyMismatch) {
      setError(policyMismatch);
      return;
    }
    setPhase("review");
  };

  const prepareSpendTransaction = useCallback(async (options: {
    signerIds: number[];
    requireFinalizedPolicyEvaluation: boolean;
    onStatus?: (message: string) => void;
  }) => {
    const dkg = loadDkgState();
    if (!dkg) {
      throw new Error("No DKG key packages found. Run DKG ceremony first.");
    }

    const connection = createConnection(network);
    const fromPubkey = new PublicKey(activeAccount!.publicKey);
    const toPubkey = new PublicKey(recipient);

    let baseTransferTx: Transaction;
    let amountAtomic: bigint;
    let tokenMint: string | null = null;

    if (selectedToken === "SOL") {
      amountAtomic = BigInt(Math.floor(parsedAmount * LAMPORTS_PER_SOL));
      baseTransferTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey,
          toPubkey,
          lamports: Number(amountAtomic),
        }),
      );
    } else {
      const tokenInfo = tokens.find((token) => token.symbol === selectedToken);
      if (!tokenInfo?.mint) throw new Error("Token mint not found");
      tokenMint = tokenInfo.mint;
      amountAtomic = BigInt(Math.round(parsedAmount * (10 ** (tokenInfo.decimals ?? 9))));
      baseTransferTx = await buildSplTransferTransaction(
        connection,
        fromPubkey,
        toPubkey,
        new PublicKey(tokenInfo.mint),
        parsedAmount,
        tokenInfo.decimals ?? 9,
      );
    }

    const client = new VaulkyrieClient(connection);
    const policyClient = new PolicyMxeClient(connection);
    const existingVault = await client.getVaultRegistry(fromPubkey);
    const [vaultRegistryPda, vaultBump] = findVaultRegistryPda(fromPubkey);
    const [authorityPda, authorityBump] = findQuantumAuthorityPda(vaultRegistryPda);
    const existingAuthority = existingVault
      ? await client.getQuantumAuthority(vaultRegistryPda)
      : null;
    let reviewedActionHash: Uint8Array | null = null;
    let finalizedPolicySnapshot: PreparedPolicySnapshot | null = null;
    let policyVersion = existingVault?.account.policyVersion ?? 1n;

    if (needsPolicyReview) {
      const policyConfig = await policyClient.getPolicyConfig(fromPubkey);
      if (!policyConfig) {
        throw new Error("Initialize the Policy Engine before signing this reviewed transfer.");
      }

      policyVersion = existingVault?.account.policyVersion ?? policyConfig.account.policyVersion;
      const reviewActionHash = await buildWalletPolicyActionHash(
        buildWalletPolicyActionPayload({
          profile: selectedPolicyProfile,
          actionType: "send",
          recipient,
          amount: parsedAmount,
          token: selectedToken,
        }),
      );

      if (options.requireFinalizedPolicyEvaluation) {
        const evaluation = await policyClient.getPolicyEvaluation(
          policyConfig.address,
          reviewActionHash,
        );
        if (!evaluation || evaluation.account.status !== PolicyEvaluationStatus.Finalized) {
          throw new Error(
            "No finalized policy evaluation matches this transfer yet. Open the Policy Engine first.",
          );
        }

        const currentPolicySlot = await connection.getSlot();
        if (evaluation.account.delayUntilSlot > BigInt(currentPolicySlot)) {
          throw new Error(
            `This policy approval is time-locked until slot ${evaluation.account.delayUntilSlot.toString()}.`,
          );
        }

        finalizedPolicySnapshot = {
          evaluationAddress: evaluation.address.toBase58(),
          receiptCommitment: bytesToHex(evaluation.account.receiptCommitment),
          decisionCommitment: bytesToHex(evaluation.account.decisionCommitment),
          reasonCode: evaluation.account.reasonCode,
          delayUntilSlot: evaluation.account.delayUntilSlot.toString(),
        };
      }

      reviewedActionHash = reviewActionHash;
    }

    let authorityHash = existingVault?.account.currentAuthorityHash ?? null;
    let authorityRoot = existingAuthority?.account.currentAuthorityRoot ?? null;

    if (!existingVault || !existingAuthority) {
      const serializedWinterAuthority = getWinterAuthorityState(activeAccount!.publicKey);
      let winterAuthority = serializedWinterAuthority
        ? await (async () => {
            try {
              return await deserializeWinterAuthoritySignerState(serializedWinterAuthority);
            } catch {
              return null;
            }
          })()
        : null;

      if (!winterAuthority && !existingVault) {
        options.onStatus?.("Generating Vaulkyrie Winter authority state...");
        winterAuthority = await createWinterAuthoritySignerState();
        storeWinterAuthorityState(
          activeAccount!.publicKey,
          serializeWinterAuthoritySignerState(winterAuthority),
        );
      }

      if (winterAuthority) {
        const initialAuthorityRoot = winterAuthority.current.root;
        if (
          existingVault &&
          !equalBytes(existingVault.account.currentAuthorityHash, initialAuthorityRoot)
        ) {
          throw new Error(
            "The stored Winter authority state does not match this vault's on-chain authority root. " +
              "Recover or re-create the vault before submitting authority-bound spends.",
          );
        }

        authorityHash = authorityHash ?? initialAuthorityRoot;
        authorityRoot = authorityRoot ?? initialAuthorityRoot;
      }

      const serializedTree = !authorityRoot ? getXmssTree(activeAccount!.publicKey) : null;
      let xmssTree = serializedTree
        ? (() => {
            try {
              return deserializeXmssTree(serializedTree);
            } catch {
              return null;
            }
          })()
        : null;

      if (!authorityRoot && !authorityHash && !xmssTree) {
        options.onStatus?.("Generating Vaulkyrie XMSS authority tree...");
        xmssTree = await generateXmssTree();
        storeXmssTree(activeAccount!.publicKey, serializeXmssTree(xmssTree));
      }

      if (xmssTree) {
        const initialAuthorityHash = getInitialXmssAuthorityHash(xmssTree);
        if (
          existingVault &&
          !equalBytes(existingVault.account.currentAuthorityHash, initialAuthorityHash)
        ) {
          throw new Error(
            "The stored XMSS authority tree does not match this vault's on-chain authority hash. " +
              "Recover or re-create the vault before submitting authority-bound spends.",
          );
        }

        authorityHash = authorityHash ?? initialAuthorityHash;
        authorityRoot = authorityRoot ?? new Uint8Array(xmssTree.root);
      }
    }

    if (!authorityHash) {
      throw new Error("Missing post-quantum authority hash for this vault.");
    }

    const sessionNonce = generateSpendSessionNonce();
    const actionHash = reviewedActionHash ?? await buildSpendActionHash({
      vaultId: fromPubkey.toBytes(),
      recipient: toPubkey.toBase58(),
      amountAtomic: amountAtomic.toString(),
      tokenSymbol: selectedToken,
      tokenMint,
      policyVersion,
      sessionNonce,
    });
    const [orchPda, orchBump] = findSpendOrchestrationPda(vaultRegistryPda, actionHash);
    const { blockhash } = await connection.getLatestBlockhash();
    const currentSlot = await connection.getSlot();
    const transferTx = new Transaction();
    transferTx.recentBlockhash = blockhash;
    transferTx.feePayer = fromPubkey;
    baseTransferTx.instructions.forEach((instruction) => transferTx.add(instruction));
    const transferMessageBytes = transferTx.serializeMessage();
    const expirySlot = BigInt(currentSlot + 200);
    const bindings = await buildSpendOrchestrationBindings({
      actionHash,
      messageBytes: transferMessageBytes,
      signerIds: options.signerIds,
      threshold: dkg.threshold,
      participantCount: dkg.participants,
      expirySlot,
    });

    const tx = new Transaction();
    if (!existingVault) {
      tx.add(createInitVaultInstruction(vaultRegistryPda, fromPubkey, {
        walletPubkey: fromPubkey,
        authorityHash,
        policyVersion,
        bump: vaultBump,
        policyMxeProgram: VAULKYRIE_POLICY_MXE_PROGRAM_ID,
      }));
    }
    if (!existingAuthority) {
      if (!authorityRoot) {
        throw new Error("Missing quantum authority root for initialization.");
      }

      tx.add(createInitAuthorityInstruction(authorityPda, vaultRegistryPda, fromPubkey, {
        currentAuthorityHash: authorityHash,
        currentAuthorityRoot: authorityRoot,
        bump: authorityBump,
      }));
    }
    tx.add(createInitSpendOrchestrationInstruction(orchPda, vaultRegistryPda, fromPubkey, {
      actionHash,
      sessionCommitment: bindings.sessionCommitment,
      signersCommitment: bindings.signersCommitment,
      signingPackageHash: bindings.signingPackageHash,
      expirySlot,
      threshold: dkg.threshold,
      participantCount: dkg.participants,
      bump: orchBump,
    }));
    tx.add(createCommitSpendOrchestrationInstruction(orchPda, vaultRegistryPda, fromPubkey, {
      actionHash,
      signingPackageHash: bindings.signingPackageHash,
    }));
    baseTransferTx.instructions.forEach((instruction) => tx.add(instruction));
    tx.add(createCompleteSpendOrchestrationInstruction(orchPda, vaultRegistryPda, fromPubkey, {
      actionHash,
      txBinding: bindings.txBinding,
    }));
    tx.recentBlockhash = blockhash;
    tx.feePayer = fromPubkey;

    return {
      connection,
      fromPubkey,
      tx,
      orchestrationAddress: orchPda.toBase58(),
      activityContext: {
        actionHash: bytesToHex(actionHash),
        orchestrationAddress: orchPda.toBase58(),
        policy: finalizedPolicySnapshot,
      } satisfies PreparedSpendActivityContext,
    };
  }, [
    activeAccount,
    getWinterAuthorityState,
    getXmssTree,
    network,
    needsPolicyReview,
    parsedAmount,
    recipient,
    selectedPolicyProfile,
    selectedToken,
    storeWinterAuthorityState,
    storeXmssTree,
    loadDkgState,
    tokens,
  ]);

  useEffect(() => {
    if (phase !== "review" || !activeAccount || !isValid || blockedByPolicy || needsPolicyReview) {
      setReviewAnalysis({ status: "idle" });
      return;
    }

    let cancelled = false;
    setReviewAnalysis({ status: "loading" });

    void (async () => {
      try {
        const dkg = loadDkgState();
        if (!dkg) {
          throw new Error("No DKG key packages found. Run DKG ceremony first.");
        }

        const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
        const signerIds = buildPreviewSignerIds(
          dkg.threshold,
          dkg.participants,
          availableKeyIds,
          dkg.participantId,
        );
        const prepared = await prepareSpendTransaction({
          signerIds,
          requireFinalizedPolicyEvaluation: false,
        });
        const analysis = await analyzeLegacyTransaction(
          prepared.connection,
          prepared.tx,
          prepared.fromPubkey.toBase58(),
        );
        if (!cancelled) {
          setOrchestrationAddress(prepared.orchestrationAddress);
          setReviewAnalysis({ status: "ready", data: analysis });
        }
      } catch (previewError) {
        if (!cancelled) {
          setReviewAnalysis({
            status: "error",
            error: previewError instanceof Error ? previewError.message : String(previewError),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeAccount,
    blockedByPolicy,
    isValid,
    loadDkgState,
    needsPolicyReview,
    phase,
    prepareSpendTransaction,
  ]);

  const handleSign = async () => {
    setPhase("signing");
    setSigningMessage("Loading DKG key packages...");
    setError("");
    setPendingSignRequest(null);
    setOrchestrationAddress("");

    try {
      const dkg = loadDkgState();
      if (!dkg) {
        throw new Error("No DKG key packages found. Run DKG ceremony first.");
      }

      setSigningMessage("Building transaction...");
      // Determine available key packages
      const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
      const hasAllKeys = availableKeyIds.length >= dkg.threshold;
      const isMultiDevice = dkg.isMultiDevice === true;
      let finalTx: Transaction | null = null;
      const fromPubkey = new PublicKey(activeAccount!.publicKey);
      const connection = createConnection(network);

      let signatureHex: string;
      let verified: boolean;
      let activityContext: PreparedSpendActivityContext | null = null;

      if (hasAllKeys && !isMultiDevice) {
        // Single-device (local DKG): sign locally with all key packages
        setSigningMessage(`Running FROST threshold signing (${dkg.threshold}-of-${dkg.participants})...`);
        const signerIds = availableKeyIds.slice(0, dkg.threshold);
        const prepared = await prepareSpendTransaction({
          signerIds,
          requireFinalizedPolicyEvaluation: true,
          onStatus: setSigningMessage,
        });
        finalTx = prepared.tx;
        setOrchestrationAddress(prepared.orchestrationAddress);
        activityContext = prepared.activityContext;
        const result = await signLocal(
          prepared.tx.serializeMessage(),
          dkg.keyPackages,
          dkg.publicKeyPackage,
          signerIds,
        );
        signatureHex = result.signatureHex;
        verified = result.verified;
      } else {
        // Multi-device: coordinate signing across devices via relay
        setPhase("coordinate");
        setSigningMessage("Connecting to relay for multi-device signing...");

        const myParticipantId = dkg.participantId ?? availableKeyIds[0] ?? 1;
        const myKeyPkg = dkg.keyPackages[myParticipantId];

        if (!myKeyPkg) {
          throw new Error(
            `No key package found for participant ${myParticipantId}. ` +
            `Available: [${availableKeyIds.join(", ")}]`
          );
        }

        const result = await runMultiDeviceSigning(
          myParticipantId,
          myKeyPkg,
          dkg.publicKeyPackage,
          dkg.threshold,
          dkg.cosigner ?? null,
          (msg) => setSigningMessage(msg),
          async (signerIds) => {
            const prepared = await prepareSpendTransaction({
              signerIds,
              requireFinalizedPolicyEvaluation: true,
              onStatus: setSigningMessage,
            });
            const analysis = await analyzeLegacyTransaction(
              prepared.connection,
              prepared.tx,
              prepared.fromPubkey.toBase58(),
            );
            return {
              message: prepared.tx.serializeMessage(),
              tx: prepared.tx,
              analysis,
              orchestrationAddress: prepared.orchestrationAddress,
              activityContext: prepared.activityContext,
            };
          },
        );
        finalTx = result.preparedTx;
        setOrchestrationAddress(result.orchestrationAddress);
        activityContext = result.activityContext;
        signatureHex = result.signatureHex;
        verified = result.verified;
      }

      if (!verified) {
        throw new Error("FROST signature verification failed");
      }

      setPhase("signing");
      setSigningMessage("Signature verified! Submitting to Solana...");

      if (!finalTx) {
        throw new Error("Spend orchestration transaction was not prepared.");
      }
      const sigBytes = hexToBytes(signatureHex);
      finalTx.addSignature(fromPubkey, Buffer.from(sigBytes));

      const rawTx = finalTx.serialize();
      const signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      cleanupRelayState();
      setTxSignature(signature);
      if (activityContext) {
        recordOrchestrationActivity(activeAccount!.publicKey, {
          id: `${signature}:${activityContext.actionHash}`,
          kind: "spend-orchestration",
          accountPublicKey: activeAccount!.publicKey,
          signature,
          amount: parsedAmount,
          token: selectedToken,
          recipient: recipient.trim(),
          timestamp: Date.now(),
          network,
          actionHash: activityContext.actionHash,
          orchestrationAddress: activityContext.orchestrationAddress,
          policy: activityContext.policy,
        });
      }
      setPhase("success");
      setPendingPolicyRequest(null);
      await Promise.all([refreshBalances(), refreshTransactions(), refreshVaultState()]);
    } catch (err) {
      cleanupRelayState();
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setPhase("error");
    }
  };

  /** Run multi-device FROST signing with a shareable session code. */
  const runMultiDeviceSigning = useCallback(async (
    participantId: number,
    keyPackageJson: string,
    publicKeyPackageJson: string,
    requiredSigners: number,
    cosigner: VaultCosignerMetadata | null,
    onStatus: (msg: string) => void,
    prepareMessage: (signerIds: number[]) => Promise<{
      message: Uint8Array;
      tx: Transaction;
      analysis: TransactionAnalysis;
      orchestrationAddress: string;
      activityContext: PreparedSpendActivityContext;
    }>,
  ) => {
    cleanupRelayState();
    const relayAvailable = await canReachRelay(relayUrl);
    if (!relayAvailable) {
      throw new Error(crossDeviceRelayUnavailableMessage());
    }
    const relayMode = "remote";
    const requestedSessionCode = generateSessionCode();

    setSigningSessionCode("");
    setRelaySessionInfo(createRelaySessionMetadata("------"));
    return new Promise<{
      signatureHex: string;
      publicKeyHex: string;
      verified: boolean;
      preparedTx: Transaction;
      orchestrationAddress: string;
      activityContext: PreparedSpendActivityContext;
    }>((resolve, reject) => {
      let settled = false;
      let signingStarted = false;

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanupRelayState();
        callback();
      };

      const relay = createRelay({
        mode: relayMode,
        participantId,
        isCoordinator: true,
        deviceName: `Signer ${participantId}`,
        relayUrl,
        sessionId: requestedSessionCode,
        events: {
          onParticipantJoined: () => {
            const connectedSignerIds = [
              participantId,
              ...relay
              .getParticipants()
              .map((candidate) => candidate.participantId)
              .filter((candidateId, index, ids) => candidateId > 0 && ids.indexOf(candidateId) === index),
            ]
              .filter((candidateId, index, ids) => ids.indexOf(candidateId) === index)
              .sort((left, right) => left - right);
            const signerIds = connectedSignerIds.slice(0, requiredSigners);
            onStatus(`Connected signers: ${Math.min(connectedSignerIds.length, requiredSigners)}/${requiredSigners}`);

            if (signingStarted || connectedSignerIds.length < requiredSigners) {
              return;
            }

            if (signerIds.length < requiredSigners) {
              return;
            }

            signingStarted = true;
            void (async () => {
              try {
                onStatus("Preparing orchestrated spend transaction...");
                const { message, tx, analysis, orchestrationAddress, activityContext } = await prepareMessage(signerIds);
                const request: SignRequestPayload = {
                  requestId: crypto.randomUUID(),
                  message: Array.from(message),
                  signerIds,
                  amount: parsedAmount,
                  token: selectedToken,
                  recipient,
                  initiator: activeAccount?.name ?? `Signer ${participantId}`,
                  network,
                  createdAt: Date.now(),
                  estimatedFeeLamports: analysis.estimatedFeeLamports,
                  computeUnitsConsumed: analysis.computeUnitsConsumed,
                  requiredSignerCount: analysis.requiredSignerCount,
                  writableAccountCount: analysis.writableAccountCount,
                };

                relay.broadcastSignRequest(request);
                setPhase("signing");
                setOrchestrationAddress(orchestrationAddress);

                const result = await runSigningOrchestrator({
                  relay,
                  participantId,
                  keyPackageJson,
                  publicKeyPackageJson,
                  message,
                  signerIds,
                  onStatus,
                });
                settle(() => resolve({ ...result, preparedTx: tx, orchestrationAddress, activityContext }));
              } catch (err) {
                settle(() => reject(err));
              }
            })();
          },
          onParticipantLeft: () => {
            onStatus(`A signer disconnected. Connected: ${relay.participantCount}/${requiredSigners}`);
          },
          onSignRequest: () => {},
          onSignRound1: (fromId, commitments) => queueOrHandleSigningMessage({ type: "round1", fromId, commitments }),
          onSignRound2: (fromId, share) => queueOrHandleSigningMessage({ type: "round2", fromId, share }),
          onError: (err) => {
            settle(() => reject(new Error(`Signing relay error: ${err}`)));
          },
          onDkgRound1: () => {},
          onDkgRound2: () => {},
          onDkgRound3Done: () => {},
          onStartDkg: () => {},
          onSignComplete: () => {},
        },
        onConnectionStateChange: (state) => {
          if (state === "connected") {
            onStatus(
              relayMode === "remote"
                ? "Connected to relay. Creating secure signing invite..."
                : "Connected to relay. Waiting for the other signer...",
            );
            relay.createSession(requiredSigners, requiredSigners, requestedSessionCode);
          } else if (state === "failed") {
            settle(() => reject(new Error("Relay connection failed")));
          }
        },
        onSessionCreated: (session) => {
          onStatus(
            cosigner?.enabled
              ? `Signing session created. Requesting ${cosigner.label}...`
              : `Signing session created: ${session.invite}. Share with other signers.`,
          );
          setSigningSessionCode(session.invite);
          setRelaySessionInfo(session);
          if (cosigner?.enabled) {
            void requestCosignerSignature({ cosigner, relayUrl, session })
              .then((accepted) => {
                if (accepted) {
                  onStatus(`${cosigner.label} is joining the signing session...`);
                }
              })
              .catch((error) => {
                settle(() => reject(error));
              });
          }
        },
      });

      relayRef.current = relay;
      relay.connect();

      signingTimeoutRef.current = window.setTimeout(() => {
        settle(() => reject(new Error("Signing timed out. Not enough signers connected within 2 minutes.")));
      }, 120_000);
    });
  }, [
    activeAccount?.name,
    cleanupRelayState,
    network,
    parsedAmount,
    recipient,
    queueOrHandleSigningMessage,
    relayUrl,
    runSigningOrchestrator,
    selectedToken,
  ]);

  const handleJoinSigningSession = useCallback(async () => {
    if (!parsedJoinSession) {
      setError("Enter the signing session invite first.");
      return;
    }

    const sessionCode = parsedJoinSession.code;

    setError("");
    setPhase("coordinate");
    setSigningMessage("Loading local signer key package...");
    setRelaySessionInfo(parsedJoinSession);
    cleanupRelayState(false);

    try {
      const dkg = loadDkgState();
      if (!dkg) {
        throw new Error("No DKG key packages found. Run DKG ceremony first.");
      }

      const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
      const myParticipantId = dkg.participantId ?? availableKeyIds[0] ?? 1;
      const joinRelayUrl = resolveRelayUrl(parsedJoinSession.relayUrl ?? relayUrl);
      const relayAvailable = await canReachRelay(joinRelayUrl);
      if (!relayAvailable) {
        throw new Error(crossDeviceRelayUnavailableMessage());
      }
      const relayMode = "remote";
      if (!parsedJoinSession.authToken) {
        throw new Error("Paste the full signing session invite from the coordinator.");
      }
      const relay = createRelay({
        mode: relayMode,
        participantId: myParticipantId,
        isCoordinator: false,
        deviceName: `Signer ${myParticipantId}`,
        relayUrl: joinRelayUrl,
        sessionId: sessionCode,
        events: {
          onParticipantJoined: () => {
            setSigningMessage("Connected. Waiting for the coordinator to share a signing request...");
          },
          onParticipantLeft: () => {
            setSigningMessage("A signer disconnected from this session.");
          },
          onSignRequest: (_fromId, request) => {
            if (!request.signerIds.includes(myParticipantId)) {
              return;
            }

            setPendingSignRequest(request);
            setSigningMessage(request.summary ?? `Review the ${request.token} transfer request before signing.`);
            setPhase("join-review");
          },
          onSignRound1: (fromId, commitments) => queueOrHandleSigningMessage({ type: "round1", fromId, commitments }),
          onSignRound2: (fromId, share) => queueOrHandleSigningMessage({ type: "round2", fromId, share }),
          onError: (relayError) => {
            cleanupRelayState();
            setError(`Signing relay error: ${relayError}`);
            setPhase("error");
          },
          onDkgRound1: () => {},
          onDkgRound2: () => {},
          onDkgRound3Done: () => {},
          onStartDkg: () => {},
          onSignComplete: () => {},
        },
        onConnectionStateChange: (state) => {
          if (state === "connected") {
            setSigningMessage("Connected. Joining signing session...");
            relay.joinSession(parsedJoinSession.invite);
          } else if (state === "failed") {
            cleanupRelayState();
            setError("Relay connection failed");
            setPhase("error");
          }
        },
      });

      relayRef.current = relay;
      setSigningSessionCode(parsedJoinSession.invite);
      relay.connect();
    } catch (err) {
      cleanupRelayState();
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [cleanupRelayState, loadDkgState, parsedJoinSession, queueOrHandleSigningMessage, relayUrl]);

  const handleApproveSigningRequest = useCallback(async () => {
    if (!pendingSignRequest || !relayRef.current) {
      setError("No signing request is available.");
      setPhase("error");
      return;
    }

    setError("");
    setPhase("signing");
    setSigningMessage("Joining threshold signing ceremony...");

    try {
      const dkg = loadDkgState();
      if (!dkg) {
        throw new Error("No DKG key packages found. Run DKG ceremony first.");
      }

      const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
      const myParticipantId = dkg.participantId ?? availableKeyIds[0] ?? 1;
      const myKeyPkg = dkg.keyPackages[myParticipantId];

      if (!myKeyPkg) {
        throw new Error(`No key package found for participant ${myParticipantId}.`);
      }

      if (!pendingSignRequest.signerIds.includes(myParticipantId)) {
        throw new Error("This device is not one of the requested signers for this transfer.");
      }

      await runSigningOrchestrator({
        relay: relayRef.current,
        participantId: myParticipantId,
        keyPackageJson: myKeyPkg,
        publicKeyPackageJson: dkg.publicKeyPackage,
        message: Uint8Array.from(pendingSignRequest.message),
        signerIds: pendingSignRequest.signerIds,
        onStatus: setSigningMessage,
      });

      cleanupRelayState(false);
      setPhase("success");
    } catch (err) {
      cleanupRelayState();
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [cleanupRelayState, loadDkgState, pendingSignRequest, runSigningOrchestrator]);

  const handleOpenPolicyEvaluation = useCallback(() => {
    if (!selectedPolicyProfile) return;

    setPendingPolicyRequest({
      profileId: selectedPolicyProfile.id,
      actionType: "send",
      recipient: recipient.trim(),
      amount: parsedAmount,
      tokenSymbol: selectedToken,
      createdAt: Date.now(),
    });
    onNavigate("policy");
  }, [onNavigate, parsedAmount, recipient, selectedPolicyProfile, selectedToken, setPendingPolicyRequest]);

  useEffect(() => {
    if (!selectedPolicyProfileId) return;
    if (!savedPolicyProfiles.some((profile) => profile.id === selectedPolicyProfileId)) {
      setSelectedPolicyProfileId("");
    }
  }, [savedPolicyProfiles, selectedPolicyProfileId]);

  useEffect(() => {
    if (!pendingPolicyRequest || pendingPolicyRequest.actionType !== "send") {
      return;
    }
    setRecipient(pendingPolicyRequest.recipient);
    setAmount(pendingPolicyRequest.amount.toString());
    setSelectedToken(pendingPolicyRequest.tokenSymbol);
    setSelectedPolicyProfileId(pendingPolicyRequest.profileId);
  }, [pendingPolicyRequest]);

  const explorerUrl = txSignature
    ? `https://explorer.solana.com/tx/${txSignature}?cluster=${network}`
    : "";
  const successAmount = pendingSignRequest?.amount ?? parsedAmount;
  const successToken = pendingSignRequest?.token ?? selectedToken;
  const successRecipient = pendingSignRequest?.recipient ?? recipient;
  const reviewFeeLamports = reviewAnalysis.status === "ready"
    ? reviewAnalysis.data.estimatedFeeLamports
    : null;
  const reviewTotalLabel = selectedToken === "SOL"
    ? reviewFeeLamports !== null
      ? `${(parsedAmount + (reviewFeeLamports / LAMPORTS_PER_SOL)).toFixed(6)} SOL`
      : `${parsedAmount.toFixed(6)} SOL + fee pending`
    : `${parsedAmount} ${selectedToken}${reviewFeeLamports !== null ? ` + ${formatFeeLabel(reviewFeeLamports)}` : " + fee pending"}`;

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

  if (phase === "coordinate") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1 items-center justify-center">
        <div className="relative mb-4">
          <div className="absolute -inset-4 bg-orange-500/20 rounded-full blur-xl animate-pulse" />
          <div className="relative h-16 w-16 rounded-full bg-orange-500/15 border-2 border-orange-500/40 flex items-center justify-center">
            <Radio className="h-8 w-8 text-orange-400 animate-pulse" />
          </div>
        </div>
        <h3 className="text-base font-semibold">Multi-Device Signing</h3>
        {signingSessionCode && (
          <div className="flex flex-col items-center gap-1 mt-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
              {relaySessionInfo.authToken ? "Session Invite" : "Session Code"}
            </p>
            <code className={`font-mono font-bold text-primary bg-primary/10 px-4 py-1.5 rounded-lg select-all ${
              relaySessionInfo.authToken ? "text-xs tracking-wide" : "text-lg tracking-[.3em]"
            }`}>
              {signingSessionCode}
            </code>
            <p className="text-[10px] text-muted-foreground mt-1">
              Share this {relaySessionInfo.authToken ? "invite" : "code"} with other vault signers
            </p>
            <p className="text-[11px] text-muted-foreground">
              Verify phrase: <span className="font-mono text-foreground">{relaySessionInfo.verificationPhrase}</span>
            </p>
          </div>
        )}
        <p className="text-xs text-muted-foreground text-center px-8 mt-2">
          {signingMessage}
        </p>
      </div>
    );
  }

  if (phase === "success") {
    const isJoinSuccess = pendingSignRequest !== null && !txSignature;
    return (
      <div className="flex flex-col gap-4 p-4 flex-1 items-center justify-center">
        <div className="relative mb-4">
          <div className="absolute -inset-4 bg-success/20 rounded-full blur-xl" />
          <div className="relative h-16 w-16 rounded-full bg-success/15 border-2 border-success/40 flex items-center justify-center">
            <Check className="h-8 w-8 text-success" />
          </div>
        </div>
        <h3 className="text-base font-semibold">{isJoinSuccess ? "Signature Completed" : "Transaction Sent!"}</h3>
        <p className="text-xs text-muted-foreground text-center">
          {isJoinSuccess && pendingSignRequest?.summary
            ? pendingSignRequest.summary
            : isJoinSuccess
            ? `You approved ${successAmount} ${successToken} to ${shortenAddress(successRecipient, 6)}.`
            : `${successAmount} ${successToken} sent to ${successRecipient.substring(0, 8)}...`}
        </p>
        {orchestrationAddress && txSignature && (
          <p className="text-[10px] text-muted-foreground text-center">
            Spend orchestration recorded at {shortenAddress(orchestrationAddress, 8)}.
          </p>
        )}
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
          onClick={() => {
            resetToForm();
            onNavigate("dashboard");
          }}
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
        <Button variant="secondary" onClick={() => resetToForm(mode)}>
          Try Again
        </Button>
        <Button variant="secondary" onClick={() => onNavigate("dashboard")}>
          Back to Dashboard
        </Button>
      </div>
      );
    }

  if (phase === "join-review" && pendingSignRequest) {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => {
              cleanupRelayState(true);
              setMode("join");
              setPhase("form");
            }}
            className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
          >
            ← Disconnect
          </button>
          <h2 className="text-lg font-semibold flex-1 text-center mr-8">Approve Signature</h2>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-3">
            {pendingSignRequest.summary && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                {pendingSignRequest.summary}
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">Amount</span>
              <span className="text-sm font-bold">{pendingSignRequest.amount} {pendingSignRequest.token}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">To</span>
              <span className="text-xs font-mono truncate max-w-[180px]">{pendingSignRequest.recipient}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">Initiated by</span>
              <span className="text-xs">{pendingSignRequest.initiator}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">Network</span>
              <span className="text-xs uppercase">{pendingSignRequest.network}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">Estimated fee</span>
              <span className="text-xs text-muted-foreground">
                {formatFeeLabel(pendingSignRequest.estimatedFeeLamports ?? null)}
              </span>
            </div>
            {(pendingSignRequest.requiredSignerCount || pendingSignRequest.writableAccountCount) && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="rounded-lg bg-muted/40 px-2 py-2">
                  <div className="text-[10px] text-muted-foreground">Required signers</div>
                  <div className="text-xs font-semibold">
                    {pendingSignRequest.requiredSignerCount ?? pendingSignRequest.signerIds.length}
                  </div>
                </div>
                <div className="rounded-lg bg-muted/40 px-2 py-2">
                  <div className="text-[10px] text-muted-foreground">Writable accounts</div>
                  <div className="text-xs font-semibold">
                    {pendingSignRequest.writableAccountCount ?? "Unknown"}
                  </div>
                </div>
              </div>
            )}
            {pendingSignRequest.computeUnitsConsumed !== undefined && pendingSignRequest.computeUnitsConsumed !== null && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 px-2 py-2 text-[10px] text-muted-foreground">
                Simulation consumed about {pendingSignRequest.computeUnitsConsumed.toLocaleString()} compute units.
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-[10px] text-muted-foreground text-center">
          Approve only if this request matches the coordinator's action on this device.
        </p>

        <div className="mt-auto flex flex-col gap-2">
          <Button className="w-full gap-2" size="lg" onClick={handleApproveSigningRequest}>
            <Check className="h-4 w-4" />
            Approve & Sign
          </Button>
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => {
              cleanupRelayState(true);
              setMode("join");
              setPhase("form");
            }}
          >
            Cancel
          </Button>
        </div>
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
              <span className="text-sm font-bold">{parsedAmount} {selectedToken}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">To</span>
              <span className="text-xs font-mono truncate max-w-[180px]">{recipient}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground">Network fee</span>
              <span className="text-xs text-muted-foreground">
                {reviewAnalysis.status === "loading"
                  ? "Estimating..."
                  : reviewAnalysis.status === "ready"
                    ? formatFeeLabel(reviewAnalysis.data.estimatedFeeLamports)
                    : reviewAnalysis.status === "error"
                      ? "Unavailable"
                      : "Pending"}
              </span>
            </div>
            <div className="border-t border-border pt-2 flex justify-between">
              <span className="text-xs font-medium">Total</span>
              <span className="text-sm font-bold">{reviewTotalLabel}</span>
            </div>
          </CardContent>
        </Card>

        {reviewAnalysis.status === "ready" && (
          <Card>
            <CardContent className="pt-4 grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-muted-foreground">Required signers</div>
                <div className="font-semibold">{reviewAnalysis.data.requiredSignerCount}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Writable accounts</div>
                <div className="font-semibold">{reviewAnalysis.data.writableAccountCount}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Instructions</div>
                <div className="font-semibold">{reviewAnalysis.data.instructionCount}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Compute units</div>
                <div className="font-semibold">
                  {reviewAnalysis.data.computeUnitsConsumed?.toLocaleString() ?? "Unavailable"}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {reviewAnalysis.status === "error" && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 text-xs text-muted-foreground">
            Preview warning: {reviewAnalysis.error}
          </div>
        )}

        {reviewAnalysis.status === "ready" && reviewAnalysis.data.simulationError && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 text-xs text-muted-foreground">
            Simulation warning: {reviewAnalysis.data.simulationError}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground text-center">
          Signing via FROST {useWalletStore.getState().vaultState?.threshold ?? 2}-of-{useWalletStore.getState().vaultState?.participants ?? 3} threshold ceremony
        </p>

        {selectedPolicyProfile && (
          <Card>
            <CardContent className="pt-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Policy profile</span>
                <span className="font-medium">{selectedPolicyProfile.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Decision mode</span>
                <span className="font-medium capitalize">{selectedPolicyProfile.approvalMode}</span>
              </div>
              {selectedPolicyProfile.notes && (
                <p className="text-[10px] text-muted-foreground">{selectedPolicyProfile.notes}</p>
              )}
            </CardContent>
          </Card>
        )}

        <div className="mt-auto space-y-2">
          {blockedByPolicy ? (
            <>
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-3 text-xs text-destructive">
                This transfer is blocked by the selected policy profile.
              </div>
              <Button className="w-full" variant="secondary" onClick={() => setPhase("form")}>
                Choose another policy
              </Button>
            </>
          ) : needsPolicyReview ? (
            <>
              <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 text-xs text-muted-foreground">
                This transfer matches a review-only policy. Open the Policy Engine to create an evaluation before signing.
              </div>
              <Button className="w-full gap-2" size="lg" onClick={handleOpenPolicyEvaluation}>
                <ArrowUpRight className="h-4 w-4" />
                Open Policy Evaluation
              </Button>
            </>
          ) : (
            <Button className="w-full gap-2" size="lg" onClick={handleSign}>
              <ArrowUpRight className="h-4 w-4" />
              Confirm & Sign
            </Button>
          )}
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
        <h2 className="text-lg font-semibold flex-1 text-center mr-8">
          {mode === "send" ? `Send ${selectedToken}` : "Join Signing Session"}
        </h2>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant={mode === "send" ? "default" : "secondary"}
          onClick={() => {
            setMode("send");
            setError("");
          }}
        >
          Send funds
        </Button>
        <Button
          type="button"
          variant={mode === "join" ? "default" : "secondary"}
          onClick={() => {
            setMode("join");
            setError("");
          }}
        >
          Join signing
        </Button>
      </div>

      {mode === "send" ? (
        <>
          <TokenDropdown
            selectedToken={selectedToken}
            balance={balance}
            tokens={tokens}
            onSelect={(sym) => { setSelectedToken(sym); setAmount(""); }}
          />

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Recipient</CardTitle>
                {contacts.length > 0 && (
                  <button
                    onClick={() => setShowContacts(!showContacts)}
                    className="text-xs text-primary hover:text-primary/80 font-medium cursor-pointer flex items-center gap-1"
                  >
                    <Users className="h-3 w-3" />
                    Contacts
                  </button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <Input
                placeholder="Solana address or contact name"
                value={recipient}
                onChange={(e) => {
                  setRecipient(e.target.value);
                  setError("");
                  setShowContacts(false);
                }}
                className="font-mono text-xs"
              />
              {(showContacts || matchingContacts.length > 0) && (
                <div className="mt-2 border border-border rounded-lg overflow-hidden">
                  {(showContacts ? contacts : matchingContacts).slice(0, 5).map((c) => (
                    <button
                      key={c.address}
                      onClick={() => { setRecipient(c.address); setShowContacts(false); }}
                      className="flex items-center gap-2 w-full px-3 py-2 hover:bg-accent/50 transition-colors text-left cursor-pointer"
                    >
                      <div className="h-6 w-6 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                        <span className="text-[10px] font-bold text-primary">
                          {c.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium">{c.name}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">{shortenAddress(c.address, 6)}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
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
                  {selectedToken}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Available: {tokenBalance.toFixed(4)} {selectedToken}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Policy profile</CardTitle>
                <button
                  onClick={() => onNavigate("policy")}
                  className="text-xs text-primary hover:text-primary/80 font-medium cursor-pointer"
                >
                  Manage
                </button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <select
                value={selectedPolicyProfileId}
                onChange={(event) => {
                  setSelectedPolicyProfileId(event.target.value);
                  setError("");
                }}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">No policy profile</option>
                {savedPolicyProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              {selectedPolicyProfile ? (
                <div className="rounded-xl border border-border bg-background/60 px-3 py-3 text-[11px] text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground">{selectedPolicyProfile.name}</p>
                  <p>
                    {selectedPolicyProfile.approvalMode === "allow"
                      ? "Can sign directly"
                      : selectedPolicyProfile.approvalMode === "review"
                        ? "Requires policy evaluation"
                        : "Blocked by policy"}
                  </p>
                  <p>
                    Token: {selectedPolicyProfile.tokenSymbol} · Max: {selectedPolicyProfile.maxAmount ?? "No cap"} · Recipients: {selectedPolicyProfile.allowedRecipients.length || "Any"}
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Choose a saved send policy if you want this transfer to follow a reusable rule.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Signing session invite</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Paste a join link, full invite, or 6-character local code"
              value={joinSessionCode}
              onChange={(e) => {
                setJoinSessionCode(e.target.value);
                setError("");
              }}
              className="font-mono text-center tracking-wide"
              maxLength={512}
            />
            {parsedJoinSession && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 text-center">
                <div className="text-[10px] uppercase tracking-wide text-primary">Verify phrase</div>
                <div className="mt-1 font-mono text-sm font-semibold text-foreground">
                  {parsedJoinSession.verificationPhrase}
                </div>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Use the join link or full invite from the coordinator on another browser or device. Local fallback still accepts a 6-character code.
            </p>
            <Button className="w-full" onClick={handleJoinSigningSession}>
              Connect to session
            </Button>
          </CardContent>
        </Card>
      )}

      {error && (
        <div className="flex items-center gap-2 text-destructive text-xs px-1">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      <div className="mt-auto">
        {mode === "send" && (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
