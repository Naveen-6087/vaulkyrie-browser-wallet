/**
 * Vaulkyrie quantum vault page.
 *
 * Uses a WinterWallet-style rolling Winternitz root:
 *   - initialize a program-owned wallet PDA
 *   - fund that PDA like a receive address
 *   - each spend signs with the current WOTS key and rolls to the next root
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield,
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
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScreenHeader } from "@/components/layout/ScreenHeader";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import {
  generateWotsKeyPair,
  generatePqcMnemonic,
  mnemonicToPqcSeed,
  validatePqcMnemonic,
  deriveWotsKeyPairFromSeed,
  deriveWotsKeyPairFromMnemonic,
  nextPqcSigningPosition,
  wotsSignMessage,
  wotsVerifyMessage,
  pqcWalletAdvanceMessage,
  bytesToHex,
  hexToBytes as hexToQuantumBytes,
  deserializeWotsKeyPair,
  serializeWotsKeyPair,
  serializeWotsSignature,
} from "@/services/quantum/wots";
import type { PqcSigningPosition, WotsKeyPair } from "@/services/quantum/wots";
import type { WalletView } from "@/types";
import { useWalletStore } from "@/store/walletStore";
import { withRpcFallback } from "@/services/solanaRpc";
import {
  createInitPqcWalletInstruction,
  createAdvancePqcWalletInstruction,
} from "@/sdk/instructions";
import { ACCOUNT_SIZE } from "@/sdk/constants";
import { findPqcWalletPda } from "@/sdk/pda";
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
  walletIdHex: string;
  publicKeyHashHex: string;
  currentRootHex: string;
  sequence: bigint | null;
  hasLocalKey: boolean;
  authorityRootHex: string;
  authorityNextLeafIndex: number | null;
  authorityNextSequence: bigint | null;
  hasWinterAuthorityState: boolean;
}

interface StoredPqcWalletKey {
  walletId: Uint8Array;
  currentKeyPair: WotsKeyPair;
  source: "random" | "bip39";
  seedHex?: string;
  position?: PqcSigningPosition;
}

function serializeStoredPqcWalletKey(
  walletId: Uint8Array,
  currentKeyPair: WotsKeyPair,
  metadata: Partial<Pick<StoredPqcWalletKey, "source" | "seedHex" | "position">> = {},
): string {
  return JSON.stringify({
    version: 3,
    walletIdHex: bytesToHex(walletId),
    currentKeyPair: JSON.parse(serializeWotsKeyPair(currentKeyPair)),
    source: metadata.source ?? "random",
    seedHex: metadata.seedHex,
    position: metadata.position,
  });
}

function deserializeStoredPqcWalletKey(serialized: string): StoredPqcWalletKey {
  const parsed = JSON.parse(serialized) as {
    version?: number;
    walletIdHex?: string;
    currentKeyPair?: unknown;
    source?: "random" | "bip39";
    seedHex?: string;
    position?: PqcSigningPosition;
  };

  if ((parsed.version === 2 || parsed.version === 3) && parsed.walletIdHex && parsed.currentKeyPair) {
    return {
      walletId: hexToQuantumBytes(parsed.walletIdHex),
      currentKeyPair: deserializeWotsKeyPair(JSON.stringify(parsed.currentKeyPair)),
      source: parsed.version === 3 ? parsed.source ?? "random" : "random",
      seedHex: parsed.seedHex,
      position: parsed.position,
    };
  }

  const legacyKeyPair = deserializeWotsKeyPair(serialized);
  return {
    walletId: legacyKeyPair.publicKeyHash,
    currentKeyPair: legacyKeyPair,
    source: "random",
  };
}

async function buildNextPqcStoredKey(storedKey: StoredPqcWalletKey): Promise<StoredPqcWalletKey> {
  if (storedKey.source === "bip39" && storedKey.seedHex && storedKey.position) {
    const nextPosition = nextPqcSigningPosition(storedKey.position);
    const nextKeyPair = await deriveWotsKeyPairFromSeed(
      hexToQuantumBytes(storedKey.seedHex),
      nextPosition,
    );
    return {
      ...storedKey,
      currentKeyPair: nextKeyPair,
      position: nextPosition,
    };
  }

  return {
    ...storedKey,
    currentKeyPair: await generateWotsKeyPair(),
    source: "random",
    seedHex: undefined,
    position: undefined,
  };
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
    getWinterAuthorityState,
    refreshBalances,
    refreshTransactions,
  } = useWalletStore();
  const [vault, setVault] = useState<QuantumVaultState>({
    status: VaultStatus.None,
    balanceLamports: 0,
    vaultAddress: "",
    walletIdHex: "",
    publicKeyHashHex: "",
    currentRootHex: "",
    sequence: null,
    hasLocalKey: false,
    authorityRootHex: "",
    authorityNextLeafIndex: null,
    authorityNextSequence: null,
    hasWinterAuthorityState: false,
  });

  const [activePanel, setActivePanel] = useState<
    "overview" | "open" | "split" | null
  >("overview");
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [migrationAmount, setMigrationAmount] = useState("");
  const [splitAmount, setSplitAmount] = useState("");
  const [splitDestination, setSplitDestination] = useState("");
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [showMnemonicImport, setShowMnemonicImport] = useState(false);
  const [generatedMnemonic, setGeneratedMnemonic] = useState("");
  const [lastProofHex, setLastProofHex] = useState("");
  const [signingSessionCode, setSigningSessionCode] = useState("");
  const [relaySessionInfo, setRelaySessionInfo] = useState(() => createRelaySessionMetadata("------"));
  const { copy, isCopied } = useCopyToClipboard({ resetAfterMs: 1500 });
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
    let walletIdHex = "";
    let publicKeyHashHex = "";
    let currentRootHex = "";
    let sequence: bigint | null = null;
    let balanceLamports = 0;
    let status: VaultStatusType = VaultStatus.None;

    const serializedKey = getQuantumVaultKey(walletAddress);
    if (serializedKey) {
      try {
        const storedKey = deserializeStoredPqcWalletKey(serializedKey);
        const keyPair = storedKey.currentKeyPair;
        hasLocalKey = true;
        walletIdHex = bytesToHex(storedKey.walletId);
        publicKeyHashHex = bytesToHex(keyPair.publicKeyHash);
        const [vaultPda] = findPqcWalletPda(storedKey.walletId);
        vaultAddress = vaultPda.toBase58();

        await withRpcFallback(network, async (connection) => {
          const client = new VaulkyrieClient(connection);
          const pqcWallet = await client.getPqcWallet(storedKey.walletId);
          if (pqcWallet) {
            currentRootHex = bytesToHex(pqcWallet.account.currentRoot);
            sequence = pqcWallet.account.sequence;
            const accountInfo = await connection.getAccountInfo(vaultPda);
            balanceLamports = accountInfo?.lamports ?? 0;
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
      walletIdHex,
      publicKeyHashHex,
      currentRootHex,
      sequence,
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

  const ensurePqcInitPayerIsFunded = useCallback(async (
    connection: Connection,
    payer: PublicKey,
  ) => {
    const rentLamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE.PqcWalletState);
    const requiredLamports = rentLamports + 10_000;
    const balanceLamports = await connection.getBalance(payer);

    if (balanceLamports < requiredLamports) {
      throw new Error(
        `Fund the active fast-vault address before initializing the PQC wallet. ` +
        `${payer.toBase58()} has ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL; ` +
        `it needs at least ${(requiredLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL for rent and network fees.`,
      );
    }
  }, []);

  const handleRequestPqcSetupAirdrop = async () => {
    if (!activeAccount?.publicKey) return;
    if (network !== "devnet") {
      setStatusMessage("Devnet faucet is only available while the wallet network is set to devnet.");
      return;
    }

    setIsProcessing(true);
    setStatusMessage("Requesting 1 SOL for PQC wallet setup...");

    try {
      const payer = new PublicKey(activeAccount.publicKey);
      const signature = await withRpcFallback(network, async (connection) => {
        const sig = await connection.requestAirdrop(payer, LAMPORTS_PER_SOL);
        const latest = await connection.getLatestBlockhash();
        await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
        return sig;
      });
      setStatusMessage(`Devnet setup funding received. Tx: ${signature}`);
      await refreshBalances();
    } catch (err) {
      setStatusMessage(
        `Faucet request failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Send a small amount of devnet SOL to ${activeAccount.publicKey}, then retry.`,
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const handleOpenVault = async (mode: "generated" | "imported" | "random" = "generated") => {
    if (!activeAccount?.publicKey) return;

    setIsProcessing(true);
    setGeneratedMnemonic("");
    setStatusMessage("Checking PQC wallet setup funding...");

    try {
      const payer = new PublicKey(activeAccount.publicKey);
      await withRpcFallback(network, async (connection) => ensurePqcInitPayerIsFunded(connection, payer));

      const position: PqcSigningPosition = { wallet: 0, parent: 0, child: 0 };
      let keyPair: WotsKeyPair;
      let seedHex: string | undefined;
      let mnemonicToShow = "";
      let source: StoredPqcWalletKey["source"] = "random";

      if (mode === "imported") {
        if (!validatePqcMnemonic(mnemonicInput)) {
          throw new Error("Enter a valid BIP39 recovery phrase before importing.");
        }
        setStatusMessage("Deriving the first Winternitz root from the BIP39 phrase...");
        const seed = await mnemonicToPqcSeed(mnemonicInput);
        seedHex = bytesToHex(seed);
        keyPair = await deriveWotsKeyPairFromSeed(seed, position);
        source = "bip39";
      } else if (mode === "generated") {
        setStatusMessage("Generating a BIP39 recovery phrase for the PQC wallet...");
        const mnemonic = generatePqcMnemonic();
        const seed = await mnemonicToPqcSeed(mnemonic);
        seedHex = bytesToHex(seed);
        keyPair = await deriveWotsKeyPairFromMnemonic(mnemonic, position);
        mnemonicToShow = mnemonic;
        source = "bip39";
      } else {
        setStatusMessage("Generating the first Winternitz wallet root...");
        keyPair = await generateWotsKeyPair();
      }

      const walletId = keyPair.publicKeyHash;
      const [vaultPda, bump] = findPqcWalletPda(walletId);

      setStatusMessage("Opening the onchain PQC wallet PDA...");
      const signature = await withRpcFallback(network, async (connection) => {
        const existing = await connection.getAccountInfo(vaultPda);
        if (existing) {
          throw new Error("A PQC wallet already exists for this Winternitz wallet id.");
        }

        const ix = createInitPqcWalletInstruction(payer, vaultPda, {
          walletId,
          currentRoot: keyPair.publicKeyHash,
          bump,
        });
        const tx = new Transaction().add(ix);
        return signAndSendQuantumTransaction(
          connection,
          tx,
          `Initialize PQC wallet ${vaultPda.toBase58()}`,
          {
            amount: 0,
            token: "PQC",
            recipient: vaultPda.toBase58(),
          },
        );
      });

      storeQuantumVaultKey(
        walletAddress,
        serializeStoredPqcWalletKey(walletId, keyPair, { source, seedHex, position: source === "bip39" ? position : undefined }),
      );
      if (mnemonicToShow) {
        setGeneratedMnemonic(mnemonicToShow);
      }
      setMnemonicInput("");
      setLastProofHex("");
      setStatusMessage(
        `PQC wallet opened. Fund ${vaultPda.toBase58()} before sending from it. Tx: ${signature}`,
      );
      setActivePanel("overview");
      await Promise.all([refreshQuantumVault(), refreshBalances(), refreshTransactions()]);
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Migrate Assets ───────────────────────────────────────────────

  const handleMigrateSolToVault = async () => {
    if (!activeAccount?.publicKey || !vault.vaultAddress) return;

    const amount = parseFloat(migrationAmount);
    if (isNaN(amount) || amount <= 0) {
      setStatusMessage("Enter a valid migration amount.");
      return;
    }

    setIsProcessing(true);
    setStatusMessage("Preparing SOL migration into the PQC wallet PDA...");

    try {
      const from = new PublicKey(activeAccount.publicKey);
      const destination = new PublicKey(vault.vaultAddress);
      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
      if (lamports <= 0) {
        throw new Error("Migration amount is too small.");
      }

      const signature = await withRpcFallback(network, async (connection) => {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: from,
            toPubkey: destination,
            lamports,
          }),
        );

        return signAndSendQuantumTransaction(
          connection,
          tx,
          `Migrate ${amount} SOL into PQC wallet ${destination.toBase58()}`,
          {
            amount,
            token: "SOL",
            recipient: destination.toBase58(),
          },
        );
      });

      setMigrationAmount("");
      setStatusMessage(`SOL migrated into the PQC wallet. Tx: ${signature}`);
      await Promise.all([refreshQuantumVault(), refreshBalances(), refreshTransactions()]);
    } catch (err) {
      setStatusMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Send From PQC Wallet ────────────────────────────────────────

  const handleSplitVault = async () => {
    if (!activeAccount?.publicKey || !vault.vaultAddress) return;

    const amount = parseFloat(splitAmount);
    if (isNaN(amount) || amount <= 0) {
      setStatusMessage("Enter a valid amount");
      return;
    }

    setIsProcessing(true);
    setStatusMessage("Building rolling Winternitz send authorization...");

    try {
      const serializedKey = getQuantumVaultKey(walletAddress);
      if (!serializedKey) {
        throw new Error("No local Winternitz key found for this PQC wallet.");
      }

      const storedKey = deserializeStoredPqcWalletKey(serializedKey);
      const keyPair = storedKey.currentKeyPair;
      const amountLamports = BigInt(Math.floor(amount * 1e9));
      const destination = new PublicKey(splitDestination.trim());
      const [pqcWalletPda] = findPqcWalletPda(storedKey.walletId);

      const pqcWallet = await withRpcFallback(network, async (connection) => {
        const client = new VaulkyrieClient(connection);
        return client.getPqcWallet(storedKey.walletId);
      });
      if (!pqcWallet) {
        throw new Error("PQC wallet state was not found onchain.");
      }
      if (bytesToHex(pqcWallet.account.currentRoot) !== bytesToHex(keyPair.publicKeyHash)) {
        throw new Error("Stored Winternitz key does not match the current onchain wallet root.");
      }

      const nextStoredKey = await buildNextPqcStoredKey(storedKey);
      const nextKeyPair = nextStoredKey.currentKeyPair;
      const message = await pqcWalletAdvanceMessage(
        storedKey.walletId,
        pqcWallet.account.currentRoot,
        nextKeyPair.publicKeyHash,
        destination.toBytes(),
        amountLamports,
        pqcWallet.account.sequence,
      );

      setStatusMessage("Signing send message with the current Winternitz key...");
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
        const ix = createAdvancePqcWalletInstruction(
          pqcWalletPda,
          destination,
          {
            signature: signatureBytes,
            nextRoot: nextKeyPair.publicKeyHash,
            amount: amountLamports,
          },
        );

        const tx = new Transaction().add(ix);
        return signAndSendQuantumTransaction(
          connection,
          tx,
          `Send ${amount} SOL from PQC wallet to ${destination.toBase58()}`,
          {
            amount,
            token: "SOL",
            recipient: destination.toBase58(),
          },
        );
      });

      storeQuantumVaultKey(
        walletAddress,
        serializeStoredPqcWalletKey(nextStoredKey.walletId, nextKeyPair, {
          source: nextStoredKey.source,
          seedHex: nextStoredKey.seedHex,
          position: nextStoredKey.position,
        }),
      );
      setStatusMessage("PQC wallet send completed. The Winternitz root rolled forward.");
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

  const handleCopyRoot = async () => {
    await copy(vault.authorityRootHex, "authority-root");
  };

  const handleCopyVaultAddress = async () => {
    if (!vault.vaultAddress) return;
    await copy(vault.vaultAddress, "vault-address");
  };

  const vaultBalanceSol = vault.balanceLamports / LAMPORTS_PER_SOL;
  const explorerClusterParam = network === "mainnet" ? "" : `?cluster=${network}`;
  const quantumVaultExplorerUrl = vault.vaultAddress
    ? `https://explorer.solana.com/address/${vault.vaultAddress}${explorerClusterParam}`
    : null;

    // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto">
      <ScreenHeader
        title="PQC Wallet"
        description="Manage a WinterWallet-style rolling Winternitz wallet and its post-quantum admin authority."
        onBack={() => onNavigate("dashboard")}
        backLabel="Back to dashboard"
        className="rounded-2xl border border-border/70 bg-card/55"
      />

      {/* Status Banner */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/15 flex items-center justify-center">
              <Atom className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">
                {vault.status === VaultStatus.None && "No PQC Wallet"}
                {vault.status === VaultStatus.Active && "PQC Wallet Active"}
              </p>
              <p className="text-xs text-muted-foreground">
                {vault.status === VaultStatus.None &&
                  "Open a Winternitz-protected PDA wallet with rolling roots"}
                {vault.status === VaultStatus.Active &&
                  "This PQC wallet can receive SOL and roll to a fresh Winternitz root after each send"}
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
                  What is a PQC Wallet?
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  A PQC wallet uses{" "}
                  <span className="text-foreground font-medium">a Blueshift-style Winternitz one-time signature</span>{" "}
                  to authorize a program-owned wallet PDA.
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Each send signs the transfer and the next root together, then the wallet
                  advances to a fresh key so the spent Winternitz key is never reused.
                </p>
                <div className="grid grid-cols-3 gap-2 pt-2">
                  <div className="text-center p-2 rounded-lg bg-muted">
                    <p className="text-lg font-bold text-primary">Roll</p>
                    <p className="text-[10px] text-muted-foreground">Rolling sends</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-muted">
                    <p className="text-lg font-bold text-primary">16</p>
                    <p className="text-[10px] text-muted-foreground">Winternitz chains</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-muted">
                    <p className="text-lg font-bold text-primary">PDA</p>
                    <p className="text-[10px] text-muted-foreground">Program wallet</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">PQC Wallet Setup</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  className="w-full gap-2"
                  size="lg"
                  onClick={() => handleOpenVault("generated")}
                  disabled={isProcessing}
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Opening wallet...
                    </>
                  ) : (
                    <>
                      <Unlock className="h-4 w-4" />
                      Create BIP39 PQC Wallet
                    </>
                  )}
                </Button>

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    className="gap-2"
                    onClick={handleRequestPqcSetupAirdrop}
                    disabled={isProcessing || network !== "devnet"}
                  >
                    <Shield className="h-4 w-4" />
                    Devnet SOL
                  </Button>
                  <Button
                    variant="secondary"
                    className="gap-2"
                    onClick={() => setShowMnemonicImport((value) => !value)}
                    disabled={isProcessing}
                  >
                    <ArrowRight className="h-4 w-4" />
                    Import Phrase
                  </Button>
                </div>

                {showMnemonicImport && (
                  <div className="space-y-2">
                    <textarea
                      value={mnemonicInput}
                      onChange={(event) => setMnemonicInput(event.target.value)}
                      placeholder="BIP39 recovery phrase"
                      className="min-h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-xs font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <Button
                      className="w-full gap-2"
                      onClick={() => handleOpenVault("imported")}
                      disabled={isProcessing || !mnemonicInput.trim()}
                    >
                      <Shield className="h-4 w-4" />
                      Initialize From Phrase
                    </Button>
                  </div>
                )}

                <p className="text-[10px] text-muted-foreground">
                  Setup rent is paid by the active Vaulkyrie vault address, so fast vaults need a small SOL balance before this step.
                </p>
              </CardContent>
            </Card>

            {generatedMnemonic && (
              <Card className="border-primary/30">
                <CardHeader>
                  <CardTitle className="text-sm">PQC Recovery Phrase</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <code className="block rounded-md bg-muted px-3 py-2 text-xs font-mono leading-relaxed">
                    {generatedMnemonic}
                  </code>
                  <Button
                    variant="secondary"
                    className="w-full gap-2"
                    onClick={() => copy(generatedMnemonic, "pqc-mnemonic")}
                  >
                    {isCopied("pqc-mnemonic") ? (
                      <Check className="h-4 w-4 text-success" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                    Copy Recovery Phrase
                  </Button>
                </CardContent>
              </Card>
            )}
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
            {generatedMnemonic && (
              <Card className="border-primary/30">
                <CardHeader>
                  <CardTitle className="text-sm">PQC Recovery Phrase</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <code className="block rounded-md bg-muted px-3 py-2 text-xs font-mono leading-relaxed">
                    {generatedMnemonic}
                  </code>
                  <Button
                    variant="secondary"
                    className="w-full gap-2"
                    onClick={() => copy(generatedMnemonic, "pqc-mnemonic")}
                  >
                    {isCopied("pqc-mnemonic") ? (
                      <Check className="h-4 w-4 text-success" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                    Copy Recovery Phrase
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Authority info */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Wallet Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">PQC Wallet Address</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-[10px] font-mono bg-muted rounded px-2 py-1.5 truncate">
                      {vault.vaultAddress}
                    </code>
                    <button
                      onClick={handleCopyVaultAddress}
                      className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
                    >
                      {isCopied("vault-address") ? (
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
                    Migrate SOL here from your active Vaulkyrie wallet, then send from this PDA with rolling Winternitz authorization.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2 rounded-lg bg-muted text-center">
                    <p className="text-sm font-bold">{vault.hasLocalKey ? "Loaded" : "Missing"}</p>
                    <p className="text-[10px] text-muted-foreground">Local Winternitz key</p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted text-center">
                    <p className="text-sm font-bold">{vault.sequence?.toString() ?? "0"}</p>
                    <p className="text-[10px] text-muted-foreground">Wallet sequence</p>
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

            {vault.walletIdHex && (
              <Card>
                <CardContent className="pt-4 pb-4 space-y-2">
                  <p className="text-[10px] text-muted-foreground">Stable Wallet ID</p>
                  <code className="text-[10px] font-mono text-muted-foreground break-all">
                    {vault.walletIdHex}
                  </code>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Migrate SOL Into PQC Wallet</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Move SOL from your current Vaulkyrie wallet into this Winternitz-protected PDA.
                  The migration uses your normal threshold signer; later withdrawal uses the
                  rolling post-quantum authorization.
                </p>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Amount (SOL)</label>
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={migrationAmount}
                    onChange={(event) => setMigrationAmount(event.target.value)}
                    className="font-mono"
                    step="0.001"
                    min="0"
                  />
                </div>
                <Button
                  className="w-full gap-2"
                  onClick={handleMigrateSolToVault}
                  disabled={isProcessing || !vault.hasLocalKey}
                >
                  {isProcessing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Shield className="h-4 w-4" />
                  )}
                  Migrate SOL
                </Button>
              </CardContent>
            </Card>

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
                          {isCopied("authority-root") ? (
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
                Send From PQC Wallet
              </Button>
            </div>
          </motion.div>
        )}

        {/* ── Send Panel ── */}
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
                <CardTitle className="text-sm">Send From PQC Wallet</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Send SOL from the onchain PQC wallet. The current Winternitz
                  key authorizes this transfer and rolls the wallet to a fresh root.
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
                  One-time key use — the wallet root advances after this send
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
                Sign & Send
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
