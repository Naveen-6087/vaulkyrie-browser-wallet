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

import { useCallback, useEffect, useRef, useState } from "react";
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
import { LAMPORTS_PER_SOL, PublicKey, Transaction, type Connection } from "@solana/web3.js";
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
import { SigningOrchestrator } from "@/services/frost/signingOrchestrator";
import { hexToBytes } from "@/services/frost/frostService";
import {
  loadDkgResult,
  prepareLegacyVaultTransaction,
  sendSignedLegacyVaultTransaction,
} from "@/services/frost/signTransaction";
import {
  createRelay,
  generateSessionCode,
  probeRelayAvailability,
  resolveRelayUrl,
  type RelayAdapter,
} from "@/services/relay/relayAdapter";
import type { SignRequestPayload } from "@/services/relay/channelRelay";
import { createRelaySessionMetadata } from "@/services/relay/sessionInvite";
import { requestCosignerSignature } from "@/services/cosigner/cosignerClient";

type BufferedSigningMessage =
  | { type: "round1"; fromId: number; commitments: number[] }
  | { type: "round2"; fromId: number; share: number[] };

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
    relayUrl,
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
  const [signingSessionCode, setSigningSessionCode] = useState("");
  const [relaySessionInfo, setRelaySessionInfo] = useState(() => createRelaySessionMetadata("------"));
  const relayRef = useRef<RelayAdapter | null>(null);
  const orchestratorRef = useRef<SigningOrchestrator | null>(null);
  const pendingSigningMessagesRef = useRef<BufferedSigningMessage[]>([]);
  const signingTimeoutRef = useRef<number | null>(null);

  const clearSigningTimeout = useCallback(() => {
    if (signingTimeoutRef.current !== null) {
      window.clearTimeout(signingTimeoutRef.current);
      signingTimeoutRef.current = null;
    }
  }, []);

  const cleanupRelayState = useCallback(() => {
    clearSigningTimeout();
    relayRef.current?.disconnect();
    relayRef.current = null;
    orchestratorRef.current = null;
    pendingSigningMessagesRef.current = [];
    setRelaySessionInfo(createRelaySessionMetadata("------"));
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

  const signAndSendQuantumTransaction = useCallback(async (
    connection: Connection,
    tx: Transaction,
    summary: string,
    request: { amount: number; token: string; recipient: string },
  ): Promise<string> => {
    if (!activeAccount?.publicKey) {
      throw new Error("No active vault selected.");
    }

    setSigningSessionCode("");
    const dkg = loadDkgResult(activeAccount.publicKey);
    const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
    const hasLocalThreshold = availableKeyIds.length >= dkg.threshold;
    const isMultiDevice = dkg.isMultiDevice === true;

    if (hasLocalThreshold && !isMultiDevice) {
      return signAndSendTransaction(connection, tx, activeAccount.publicKey, setStatusMessage);
    }

    const participantId = dkg.participantId ?? availableKeyIds[0] ?? 1;
    const keyPackageJson = dkg.keyPackages[participantId];
    if (!keyPackageJson) {
      throw new Error(`No key package found for participant ${participantId}.`);
    }

    cleanupRelayState();
    const relayAvailable = await canReachRelay(relayUrl);
    if (!relayAvailable) {
      throw new Error(crossDeviceRelayUnavailableMessage());
    }
    const relayMode = "remote";
    const requestedSessionCode = generateSessionCode();
    setSigningSessionCode("");
    setRelaySessionInfo(createRelaySessionMetadata(requestedSessionCode));

    const result = await new Promise<{ signatureHex: string; verified: boolean }>((resolve, reject) => {
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
        deviceName: `Quantum signer ${participantId}`,
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
            const signerIds = connectedSignerIds.slice(0, dkg.threshold);

            setStatusMessage(`Connected signers: ${Math.min(connectedSignerIds.length, dkg.threshold)}/${dkg.threshold}`);
            if (signingStarted || connectedSignerIds.length < dkg.threshold) {
              return;
            }

            if (signerIds.length < dkg.threshold) {
              return;
            }

            signingStarted = true;
            void (async () => {
              try {
                setStatusMessage("Preparing quantum vault transaction for threshold signing...");
                await prepareLegacyVaultTransaction(connection, tx, activeAccount.publicKey);
                const message = tx.serializeMessage();
                const signRequest: SignRequestPayload = {
                  requestId: crypto.randomUUID(),
                  message: Array.from(message),
                  signerIds,
                  amount: request.amount,
                  token: request.token,
                  recipient: request.recipient,
                  initiator: activeAccount.name ?? `Quantum signer ${participantId}`,
                  network,
                  createdAt: Date.now(),
                  purpose: "bootstrap",
                  summary,
                };

                relay.broadcastSignRequest(signRequest);
                setStatusMessage("Quantum vault signing request sent. Waiting for signer approvals...");
                const signed = await runSigningOrchestrator({
                  relay,
                  participantId,
                  keyPackageJson,
                  publicKeyPackageJson: dkg.publicKeyPackage,
                  message,
                  signerIds,
                  onStatus: setStatusMessage,
                });
                settle(() => resolve(signed));
              } catch (error) {
                settle(() => reject(error));
              }
            })();
          },
          onParticipantLeft: () => {
            setStatusMessage(`A signer disconnected. Connected: ${relay.participantCount}/${dkg.threshold}`);
          },
          onSignRequest: () => {},
          onSignRound1: (fromId, commitments) => queueOrHandleSigningMessage({ type: "round1", fromId, commitments }),
          onSignRound2: (fromId, share) => queueOrHandleSigningMessage({ type: "round2", fromId, share }),
          onError: (_fromId, relayError) => {
            settle(() => reject(new Error(`Signing relay error: ${relayError}`)));
          },
          onDkgRound1: () => {},
          onDkgRound2: () => {},
          onDkgRound3Done: () => {},
          onStartDkg: () => {},
          onSignComplete: () => {},
        },
        onConnectionStateChange: (state) => {
          if (state === "connected") {
            setStatusMessage(
              relayMode === "remote"
                ? "Connected to relay. Creating secure quantum vault signing invite..."
                : "Connected to relay. Waiting for another signer...",
            );
            relay.createSession(dkg.threshold, dkg.threshold, requestedSessionCode);
          } else if (state === "failed") {
            settle(() => reject(new Error("Relay connection failed")));
          }
        },
        onSessionCreated: (session) => {
          setSigningSessionCode(session.invite);
          setRelaySessionInfo(session);
          setStatusMessage(
            dkg.cosigner?.enabled
              ? `Signing session created. Requesting ${dkg.cosigner.label}...`
              : `Signing session created: ${session.invite}. Share it with another signer.`,
          );
          if (dkg.cosigner?.enabled) {
            void requestCosignerSignature({ cosigner: dkg.cosigner, relayUrl, session })
              .then((accepted) => {
                if (accepted) {
                  setStatusMessage(`${dkg.cosigner!.label} is joining the signing session...`);
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
        settle(() => reject(new Error("Quantum vault signing timed out. Not enough signers connected within 2 minutes.")));
      }, 120_000);
    });

    if (!result.verified) {
      throw new Error("FROST signature verification failed.");
    }

    return sendSignedLegacyVaultTransaction(
      connection,
      tx,
      activeAccount.publicKey,
      hexToBytes(result.signatureHex),
    );
  }, [
    activeAccount?.name,
    activeAccount?.publicKey,
    cleanupRelayState,
    network,
    queueOrHandleSigningMessage,
    relayUrl,
    runSigningOrchestrator,
  ]);

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
        return signAndSendQuantumTransaction(
          connection,
          tx,
          `Initialize quantum vault ${vaultPda.toBase58()}`,
          {
            amount: 0,
            token: "QUANTUM",
            recipient: vaultPda.toBase58(),
          },
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
        return signAndSendQuantumTransaction(
          connection,
          tx,
          `Split ${amount} SOL from quantum vault to ${destination.toBase58()}`,
          {
            amount,
            token: "SOL",
            recipient: destination.toBase58(),
          },
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
        return signAndSendQuantumTransaction(
          connection,
          tx,
          `Close quantum vault and refund ${refund.toBase58()}`,
          {
            amount: vault.balanceLamports / LAMPORTS_PER_SOL,
            token: "SOL",
            recipient: refund.toBase58(),
          },
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

      {isProcessing && relaySessionInfo.code !== "------" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Signing Session Invite</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {signingSessionCode ? (
              <>
                <Input
                  value={signingSessionCode}
                  readOnly
                  className="font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <p className="text-[10px] text-muted-foreground">
                  Open Send &gt; Join Signing Session on another signer device and paste this invite.
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Verify phrase: <span className="font-mono text-foreground">{relaySessionInfo.verificationPhrase}</span>
                </p>
              </>
            ) : (
              <div className="rounded-xl border border-border bg-muted/20 px-3 py-3 text-[11px] text-muted-foreground">
                Creating the secure cross-device invite. Wait for the full invite to appear before copying it to the next signer.
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
