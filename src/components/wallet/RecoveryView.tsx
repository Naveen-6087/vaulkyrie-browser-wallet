import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { motion } from "framer-motion";
import {
  Download,
  ExternalLink,
  FileUp,
  KeyRound,
  LifeBuoy,
  Loader2,
  Radio,
  RefreshCw,
  Shield,
  Sparkles,
} from "lucide-react";
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { WalletView, RecoverySessionRecord } from "@/types";
import { useWalletStore } from "@/store/walletStore";
import {
  exportEncryptedWalletBackup,
  importEncryptedWalletBackup,
  previewEncryptedWalletBackup,
  type WalletBackupPreview,
} from "@/lib/walletBackup";
import { NETWORKS } from "@/lib/constants";
import { shortenAddress } from "@/lib/utils";
import { createConnection, withRpcFallback } from "@/services/solanaRpc";
import { VaulkyrieClient } from "@/sdk/client";
import { ACCOUNT_SIZE, RecoveryStatus, VaultStatus, VAULKYRIE_CORE_PROGRAM_ID } from "@/sdk/constants";
import {
  createCompleteRecoveryInstruction,
  createInitRecoveryInstruction,
  createSetVaultStatusInstruction,
} from "@/sdk/instructions";
import { findVaultRegistryPda } from "@/sdk/pda";
import {
  loadDkgResult,
  prepareLegacyVaultTransaction,
  sendSignedLegacyVaultTransaction,
  signThresholdMessage,
} from "@/services/frost/signTransaction";
import { hexToBytes } from "@/services/frost/frostService";
import { SigningOrchestrator } from "@/services/frost/signingOrchestrator";
import {
  createRelay,
  generateSessionCode,
  probeRelayAvailability,
  resolveRelayUrl,
  type RelayAdapter,
} from "@/services/relay/relayAdapter";
import type { SignRequestPayload } from "@/services/relay/channelRelay";
import { createRelaySessionMetadata } from "@/services/relay/sessionInvite";
import {
  generateXmssTree,
  getInitialXmssAuthorityHash,
  serializeXmssTree,
} from "@/services/quantum/wots";

interface RecoveryViewProps {
  onNavigate: (view: WalletView) => void;
}

type RecoveryPhase = "dashboard" | "coordinate";

type BufferedSigningMessage =
  | { type: "round1"; fromId: number; commitments: number[] }
  | { type: "round2"; fromId: number; share: number[] };

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parse32ByteInput(value: string, label: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = parseInt(trimmed.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  try {
    return new PublicKey(trimmed).toBytes();
  } catch {
    throw new Error(`${label} must be a 32-byte hex string or base58 public key.`);
  }
}

function addressExplorerUrl(address: string, network: keyof typeof NETWORKS): string {
  const clusterSuffix = network === "mainnet" ? "" : `?cluster=${network}`;
  return `https://explorer.solana.com/address/${address}${clusterSuffix}`;
}

function transactionExplorerUrl(signature: string, network: keyof typeof NETWORKS): string {
  const clusterSuffix = network === "mainnet" ? "" : `?cluster=${network}`;
  return `https://explorer.solana.com/tx/${signature}${clusterSuffix}`;
}

function sessionTone(status: RecoverySessionRecord["status"]): "default" | "success" | "warning" | "destructive" | "outline" {
  switch (status) {
    case "complete":
      return "success";
    case "expired":
      return "destructive";
    case "unknown":
      return "outline";
    default:
      return "warning";
  }
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

async function buildRecoveryCommitment(payload: Record<string, unknown>): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(digest);
}

export function RecoveryView({ onNavigate }: RecoveryViewProps) {
  const {
    activeAccount,
    network,
    relayUrl,
    accounts,
    contacts,
    policyProfiles,
    orchestrationHistory,
    securityPreferences,
    setLocked,
    storeXmssTree,
    upsertRecoverySession,
    getRecoverySessions,
  } = useWalletStore();

  const [phase, setPhase] = useState<RecoveryPhase>("dashboard");
  const [actionMsg, setActionMsg] = useState("");
  const [screenError, setScreenError] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessions, setSessions] = useState<RecoverySessionRecord[]>([]);
  const [selectedRecoveryId, setSelectedRecoveryId] = useState("");

  const [backupPassword, setBackupPassword] = useState("");
  const [backupConfirm, setBackupConfirm] = useState("");
  const [backupStatus, setBackupStatus] = useState("");
  const [backupError, setBackupError] = useState("");
  const [isExportingBackup, setIsExportingBackup] = useState(false);

  const [importBackupJson, setImportBackupJson] = useState("");
  const [importBackupPassword, setImportBackupPassword] = useState("");
  const [importPreview, setImportPreview] = useState<WalletBackupPreview | null>(null);
  const [importError, setImportError] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [previewingImport, setPreviewingImport] = useState(false);
  const [importingBackup, setImportingBackup] = useState(false);

  const [expirySlotsInput, setExpirySlotsInput] = useState("500");
  const [newThresholdInput, setNewThresholdInput] = useState("2");
  const [newParticipantCountInput, setNewParticipantCountInput] = useState("3");
  const [stagingRecovery, setStagingRecovery] = useState(false);
  const [completingRecovery, setCompletingRecovery] = useState(false);
  const [refreshingSessions, setRefreshingSessions] = useState(false);
  const [completeGroupKeyInput, setCompleteGroupKeyInput] = useState("");
  const [completeAuthorityHashInput, setCompleteAuthorityHashInput] = useState("");
  const [generatingAuthorityHash, setGeneratingAuthorityHash] = useState(false);
  const [signingSessionCode, setSigningSessionCode] = useState("");
  const [relaySessionInfo, setRelaySessionInfo] = useState(() => createRelaySessionMetadata("------"));

  const relayRef = useRef<RelayAdapter | null>(null);
  const orchestratorRef = useRef<SigningOrchestrator | null>(null);
  const pendingSigningMessagesRef = useRef<BufferedSigningMessage[]>([]);
  const signingTimeoutRef = useRef<number | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedRecoveryId) ?? null,
    [selectedRecoveryId, sessions],
  );

  const clearSigningTimeout = useCallback(() => {
    if (signingTimeoutRef.current !== null) {
      window.clearTimeout(signingTimeoutRef.current);
      signingTimeoutRef.current = null;
    }
  }, []);

  const cleanupRelayState = useCallback((resetInvite = true) => {
    clearSigningTimeout();
    relayRef.current?.disconnect();
    relayRef.current = null;
    orchestratorRef.current = null;
    pendingSigningMessagesRef.current = [];
    if (resetInvite) {
      setSigningSessionCode("");
      setRelaySessionInfo(createRelaySessionMetadata("------"));
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

  const runMultiDeviceRecoverySigning = useCallback(async (params: {
    participantId: number;
    keyPackageJson: string;
    publicKeyPackageJson: string;
    threshold: number;
    prepareMessage: () => Promise<Uint8Array>;
    summary: string;
  }) => {
    cleanupRelayState();
    const relayAvailable = await canReachRelay(relayUrl);
    if (!relayAvailable) {
      throw new Error(crossDeviceRelayUnavailableMessage());
    }
    const relayMode = "remote";
    const requestedSessionCode = generateSessionCode();

    setPhase("coordinate");
    setSigningSessionCode("");
    setRelaySessionInfo(createRelaySessionMetadata("------"));

    return new Promise<{ signatureHex: string; verified: boolean }>((resolve, reject) => {
      let settled = false;
      let signingStarted = false;

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanupRelayState(false);
        callback();
      };

      const relay = createRelay({
        mode: relayMode,
        participantId: params.participantId,
        isCoordinator: true,
        deviceName: `Recovery signer ${params.participantId}`,
        relayUrl,
        sessionId: requestedSessionCode,
        events: {
          onParticipantJoined: () => {
            const connectedSignerIds = [
              params.participantId,
              ...relay
                .getParticipants()
                .map((candidate) => candidate.participantId)
                .filter((candidateId, index, ids) => candidateId > 0 && ids.indexOf(candidateId) === index),
            ]
              .filter((candidateId, index, ids) => ids.indexOf(candidateId) === index)
              .sort((left, right) => left - right);
            const signerIds = connectedSignerIds.slice(0, params.threshold);

            setActionMsg(`Connected signers: ${Math.min(connectedSignerIds.length, params.threshold)}/${params.threshold}`);
            if (signingStarted || connectedSignerIds.length < params.threshold) {
              return;
            }

            if (signerIds.length < params.threshold) {
              return;
            }

            signingStarted = true;
            void (async () => {
              try {
                setActionMsg("Preparing recovery transaction...");
                const message = await params.prepareMessage();
                const request: SignRequestPayload = {
                  requestId: crypto.randomUUID(),
                  message: Array.from(message),
                  signerIds,
                  amount: 0,
                  token: "RECOVERY",
                  recipient: activeAccount?.publicKey ?? "",
                  initiator: activeAccount?.name ?? `Recovery signer ${params.participantId}`,
                  network,
                  createdAt: Date.now(),
                  summary: params.summary,
                };

                relay.broadcastSignRequest(request);
                setActionMsg("Recovery signing request sent. Waiting for signer approvals...");
                const result = await runSigningOrchestrator({
                  relay,
                  participantId: params.participantId,
                  keyPackageJson: params.keyPackageJson,
                  publicKeyPackageJson: params.publicKeyPackageJson,
                  message,
                  signerIds,
                  onStatus: setActionMsg,
                });
                settle(() => resolve(result));
              } catch (error) {
                settle(() => reject(error));
              }
            })();
          },
          onParticipantLeft: () => {
            setActionMsg(`A signer disconnected. Connected: ${relay.participantCount}/${params.threshold}`);
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
            setActionMsg(
              relayMode === "remote"
                ? "Connected to relay. Creating secure recovery signing invite..."
                : "Connected to relay. Waiting for another signer...",
            );
            relay.createSession(params.threshold, params.threshold, requestedSessionCode);
          } else if (state === "failed") {
            settle(() => reject(new Error("Relay connection failed")));
          }
        },
        onSessionCreated: (session) => {
          setActionMsg(`Recovery signing session created: ${session.invite}. Share it with another signer.`);
          setSigningSessionCode(session.invite);
          setRelaySessionInfo(session);
        },
      });

      relayRef.current = relay;
      relay.connect();

      signingTimeoutRef.current = window.setTimeout(() => {
        settle(() => reject(new Error("Recovery signing timed out. Not enough signers connected within 2 minutes.")));
      }, 120_000);
    });
  }, [
    activeAccount?.name,
    activeAccount?.publicKey,
    cleanupRelayState,
    network,
    queueOrHandleSigningMessage,
    relayUrl,
    runSigningOrchestrator,
  ]);

  const signAndSendRecoveryTransaction = useCallback(async (
    connection: Connection,
    tx: Transaction,
    summary: string,
    extraSigners: Keypair[] = [],
  ): Promise<string> => {
    if (!activeAccount?.publicKey) {
      throw new Error("No active vault selected.");
    }

    const dkg = loadDkgResult(activeAccount.publicKey);
    const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
    const hasLocalThreshold = availableKeyIds.length >= dkg.threshold;
    const isMultiDevice = dkg.isMultiDevice === true;

    if (hasLocalThreshold && !isMultiDevice) {
      await prepareLegacyVaultTransaction(connection, tx, activeAccount.publicKey);
      extraSigners.forEach((signer) => tx.partialSign(signer));
      setActionMsg("Signing recovery transaction...");
      const signatureBytes = await signThresholdMessage(activeAccount.publicKey, tx.serializeMessage());
      setActionMsg("Submitting to Solana...");
      return sendSignedLegacyVaultTransaction(connection, tx, activeAccount.publicKey, signatureBytes);
    }

    const participantId = dkg.participantId ?? availableKeyIds[0] ?? 1;
    const keyPackageJson = dkg.keyPackages[participantId];
    if (!keyPackageJson) {
      throw new Error(`No key package found for participant ${participantId}.`);
    }

    const result = await runMultiDeviceRecoverySigning({
      participantId,
      keyPackageJson,
      publicKeyPackageJson: dkg.publicKeyPackage,
      threshold: dkg.threshold,
      prepareMessage: async () => {
        await prepareLegacyVaultTransaction(connection, tx, activeAccount.publicKey);
        extraSigners.forEach((signer) => tx.partialSign(signer));
        return tx.serializeMessage();
      },
      summary,
    });

    if (!result.verified) {
      throw new Error("FROST signature verification failed");
    }

    setActionMsg("Signature verified! Submitting to Solana...");
    return sendSignedLegacyVaultTransaction(
      connection,
      tx,
      activeAccount.publicKey,
      hexToBytes(result.signatureHex),
    );
  }, [activeAccount?.publicKey, runMultiDeviceRecoverySigning]);

  const loadSessions = useCallback(async () => {
    if (!activeAccount?.publicKey) {
      setSessions([]);
      setSelectedRecoveryId("");
      return;
    }

    const storedSessions = getRecoverySessions(activeAccount.publicKey);
    if (storedSessions.length === 0) {
      setSessions([]);
      setSelectedRecoveryId("");
      return;
    }

    const { updatedSessions } = await withRpcFallback(network, async (connection) => {
      const client = new VaulkyrieClient(connection);
      const currentSlot = BigInt(await connection.getSlot("confirmed"));

      const refreshed: RecoverySessionRecord[] = await Promise.all(
        storedSessions.map(async (session) => {
          try {
            const account = await client.getRecoveryState(new PublicKey(session.recoveryAccount));
            if (!account) {
              const expired = currentSlot >= BigInt(session.expirySlot);
              return {
                ...session,
                status: expired ? "expired" : session.status,
                updatedAt: Date.now(),
              } satisfies RecoverySessionRecord;
            }

            return {
              ...session,
              status:
                account.status === RecoveryStatus.Complete
                  ? "complete"
                  : currentSlot >= account.expirySlot
                    ? "expired"
                    : "pending",
              expirySlot: account.expirySlot.toString(),
              newThreshold: account.newThreshold,
              newParticipantCount: account.newParticipantCount,
              newGroupKey: bytesToHex(account.newGroupKey),
              newAuthorityHash: bytesToHex(account.newAuthorityHash),
              updatedAt: Date.now(),
            } satisfies RecoverySessionRecord;
          } catch {
            return {
              ...session,
              status: "unknown",
              updatedAt: Date.now(),
            } satisfies RecoverySessionRecord;
          }
        }),
      );

      return { updatedSessions: refreshed };
    });

    updatedSessions.forEach((session) => {
      upsertRecoverySession(activeAccount.publicKey, session);
    });
    setSessions(updatedSessions);
    setSelectedRecoveryId((current) => current || updatedSessions[0]?.id || "");
  }, [activeAccount?.publicKey, getRecoverySessions, network, upsertRecoverySession]);

  useEffect(() => {
    let cancelled = false;
    setLoadingSessions(true);
    setScreenError("");

    void loadSessions()
      .catch((error) => {
        if (!cancelled) {
          setScreenError(error instanceof Error ? error.message : "Failed to load recovery sessions.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSessions(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  const handleRefreshSessions = async () => {
    setRefreshingSessions(true);
    setScreenError("");
    try {
      await loadSessions();
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : "Failed to refresh recovery sessions.");
    } finally {
      setRefreshingSessions(false);
    }
  };

  const handleExportBackup = async () => {
    if (accounts.length === 0) {
      setBackupError("Create or restore a vault before exporting a backup.");
      return;
    }
    if (backupPassword.length < 10) {
      setBackupError("Backup password must be at least 10 characters.");
      return;
    }
    if (backupPassword !== backupConfirm) {
      setBackupError("Backup passwords do not match.");
      return;
    }

    setIsExportingBackup(true);
    setBackupError("");
    setBackupStatus("");

    try {
      const backup = await exportEncryptedWalletBackup(backupPassword);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `vaulkyrie-backup-${new Date(backup.exportedAt).toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);

      setBackupStatus("Encrypted backup downloaded. Use it to restore this wallet on another device.");
      setBackupPassword("");
      setBackupConfirm("");
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "Failed to export encrypted backup.");
    } finally {
      setIsExportingBackup(false);
    }
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      setImportBackupJson(text);
      setImportPreview(null);
      setImportError("");
      setImportStatus("");
    } catch {
      setImportError("Failed to read the selected backup file.");
    } finally {
      event.target.value = "";
    }
  };

  const handlePreviewImport = async () => {
    if (!importBackupJson.trim()) {
      setImportError("Paste a backup JSON payload or choose a backup file first.");
      return;
    }
    if (!importBackupPassword) {
      setImportError("Enter the backup password used when exporting this wallet.");
      return;
    }

    setPreviewingImport(true);
    setImportError("");
    setImportStatus("");
    try {
      const preview = await previewEncryptedWalletBackup(importBackupJson, importBackupPassword);
      setImportPreview(preview);
    } catch (error) {
      setImportPreview(null);
      setImportError(error instanceof Error ? error.message : "Failed to preview wallet backup.");
    } finally {
      setPreviewingImport(false);
    }
  };

  const handleRestoreImport = async () => {
    if (!importBackupJson.trim()) {
      setImportError("Paste a backup JSON payload or choose a backup file first.");
      return;
    }
    if (!importBackupPassword) {
      setImportError("Enter the backup password used when exporting this wallet.");
      return;
    }

    setImportingBackup(true);
    setImportError("");
    setImportStatus("");
    try {
      await importEncryptedWalletBackup(importBackupJson, importBackupPassword);
      setImportStatus("Backup restored. Vaulkyrie locked this device so you can unlock into the restored vault.");
      setLocked(true);
      onNavigate("lock");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Failed to restore wallet backup.");
    } finally {
      setImportingBackup(false);
    }
  };

  const handleStageRecovery = async () => {
    if (!activeAccount?.publicKey) {
      setScreenError("Unlock a vault before starting recovery.");
      return;
    }

    const expirySlots = Number.parseInt(expirySlotsInput, 10);
    const newThreshold = Number.parseInt(newThresholdInput, 10);
    const newParticipantCount = Number.parseInt(newParticipantCountInput, 10);

    if (!Number.isFinite(expirySlots) || expirySlots < 50) {
      setScreenError("Expiry window must be at least 50 slots.");
      return;
    }
    if (!Number.isFinite(newThreshold) || newThreshold < 1) {
      setScreenError("New threshold must be at least 1.");
      return;
    }
    if (!Number.isFinite(newParticipantCount) || newParticipantCount < newThreshold) {
      setScreenError("Participant count must be greater than or equal to the threshold.");
      return;
    }

    setStagingRecovery(true);
    setScreenError("");
    setActionMsg("Preparing recovery coordination...");

    try {
      const connection = createConnection(network);
      const walletPubkey = new PublicKey(activeAccount.publicKey);
      const [vaultRegistryPda] = findVaultRegistryPda(walletPubkey);
      const client = new VaulkyrieClient(connection);
      const vaultExists = await client.vaultExists(walletPubkey);
      if (!vaultExists) {
        throw new Error("Bootstrap this vault onchain before starting recovery.");
      }

      const currentSlot = await connection.getSlot("confirmed");
      const expirySlot = BigInt(currentSlot + expirySlots);
      const recoveryCommitment = await buildRecoveryCommitment({
        vault: activeAccount.publicKey,
        network,
        expirySlot: expirySlot.toString(),
        newThreshold,
        newParticipantCount,
        createdAt: Date.now(),
      });
      const recoveryAccount = Keypair.generate();
      const rentLamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE.RecoveryState);

      const tx = new Transaction().add(
        createSetVaultStatusInstruction(vaultRegistryPda, walletPubkey, { status: VaultStatus.Recovery }),
        SystemProgram.createAccount({
          fromPubkey: walletPubkey,
          newAccountPubkey: recoveryAccount.publicKey,
          lamports: rentLamports,
          space: ACCOUNT_SIZE.RecoveryState,
          programId: VAULKYRIE_CORE_PROGRAM_ID,
        }),
        createInitRecoveryInstruction(recoveryAccount.publicKey, vaultRegistryPda, {
          vaultPubkey: walletPubkey,
          recoveryCommitment,
          expirySlot,
          newThreshold,
          newParticipantCount,
          bump: 0,
        }),
      );

      const signature = await signAndSendRecoveryTransaction(
        connection,
        tx,
        `Stage recovery coordination for ${activeAccount.name} (${newThreshold}-of-${newParticipantCount})`,
        [recoveryAccount],
      );

      const session: RecoverySessionRecord = {
        id: recoveryAccount.publicKey.toBase58(),
        accountPublicKey: activeAccount.publicKey,
        recoveryAccount: recoveryAccount.publicKey.toBase58(),
        network,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: "pending",
        expirySlot: expirySlot.toString(),
        newThreshold,
        newParticipantCount,
        recoveryCommitment: bytesToHex(recoveryCommitment),
        initSignature: signature,
      };

      upsertRecoverySession(activeAccount.publicKey, session);
      setSelectedRecoveryId(session.id);
      setActionMsg("Recovery coordination submitted. Share the new vault details before completing recovery.");
      setPhase("dashboard");
      await loadSessions();
    } catch (error) {
      setPhase("dashboard");
      setScreenError(error instanceof Error ? error.message : "Failed to start recovery coordination.");
    } finally {
      setStagingRecovery(false);
    }
  };

  const handleGenerateAuthorityHash = async () => {
    try {
      setGeneratingAuthorityHash(true);
      setScreenError("");
      const newGroupKeyBytes = parse32ByteInput(completeGroupKeyInput, "Recovered group public key");
      const recoveredVaultAddress = new PublicKey(newGroupKeyBytes).toBase58();
      const xmssTree = await generateXmssTree();
      storeXmssTree(recoveredVaultAddress, serializeXmssTree(xmssTree));
      setCompleteAuthorityHashInput(bytesToHex(getInitialXmssAuthorityHash(xmssTree)));
      setActionMsg(`Generated a fresh Vaulkyrie authority tree for ${shortenAddress(recoveredVaultAddress)}.`);
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : "Failed to generate a new authority hash.");
    } finally {
      setGeneratingAuthorityHash(false);
    }
  };

  const handleCompleteRecovery = async () => {
    if (!selectedSession) {
      setScreenError("Select a recovery session first.");
      return;
    }

    setCompletingRecovery(true);
    setScreenError("");
    setActionMsg("Preparing recovery completion...");

    try {
      const connection = createConnection(network);
      const newGroupKey = parse32ByteInput(completeGroupKeyInput, "Recovered group public key");
      const newAuthorityHash = parse32ByteInput(completeAuthorityHashInput, "Recovered authority hash");
      const tx = new Transaction().add(
        createCompleteRecoveryInstruction(new PublicKey(selectedSession.recoveryAccount), {
          newGroupKey,
          newAuthorityHash,
        }),
      );

      const signature = await signAndSendRecoveryTransaction(
        connection,
        tx,
        `Complete recovery for ${shortenAddress(selectedSession.recoveryAccount)}`,
      );

      upsertRecoverySession(selectedSession.accountPublicKey, {
        ...selectedSession,
        status: "complete",
        updatedAt: Date.now(),
        completeSignature: signature,
        newGroupKey: bytesToHex(newGroupKey),
        newAuthorityHash: bytesToHex(newAuthorityHash),
      });

      setActionMsg("Recovery state finalized onchain. Import the recovered vault backup on this device if needed.");
      setPhase("dashboard");
      await loadSessions();
    } catch (error) {
      setPhase("dashboard");
      setScreenError(error instanceof Error ? error.message : "Failed to complete recovery.");
    } finally {
      setCompletingRecovery(false);
    }
  };

  if (phase === "coordinate") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-6 flex-1">
        <div className="relative mb-2">
          <div className="absolute -inset-4 rounded-full bg-orange-500/20 blur-xl animate-pulse" />
          <div className="relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-orange-500/40 bg-orange-500/15">
            <Radio className="h-8 w-8 animate-pulse text-orange-400" />
          </div>
        </div>
        <h3 className="text-base font-semibold">Recovery Signing</h3>
        {signingSessionCode && (
          <div className="flex flex-col items-center gap-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {relaySessionInfo.authToken ? "Session Invite" : "Session Code"}
            </p>
            <code
              className={`select-all rounded-lg bg-primary/10 px-4 py-1.5 font-mono font-bold text-primary ${
                relaySessionInfo.authToken ? "text-xs tracking-wide" : "text-lg tracking-[.3em]"
              }`}
            >
              {signingSessionCode}
            </code>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Share this {relaySessionInfo.authToken ? "invite" : "code"} with another vault signer
            </p>
            <p className="text-[11px] text-muted-foreground">
              Verify phrase: <span className="font-mono text-foreground">{relaySessionInfo.verificationPhrase}</span>
            </p>
          </div>
        )}
        <p className="max-w-[280px] text-center text-xs text-muted-foreground">{actionMsg}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 flex-1">
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => onNavigate("settings")}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold flex-1 text-center mr-8">Recovery & Restore</h2>
      </div>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
        <Card className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10">
              <LifeBuoy className="h-5 w-5 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold">Two recovery tools, one place</p>
              <p className="text-xs text-muted-foreground">
                Use encrypted backup import/export to move this device&apos;s local vault state. Use onchain recovery coordination when you need to rotate to a brand-new threshold group and authority root.
              </p>
            </div>
          </div>
          {screenError && <p className="text-xs text-red-400">{screenError}</p>}
          {actionMsg && <p className="text-xs text-muted-foreground">{actionMsg}</p>}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Encrypted backup export
            </p>
          </div>
          <div className="space-y-3 p-4">
            <p className="text-xs text-muted-foreground">
              This backup includes local DKG material, policy profiles, orchestration history, recovery sessions, contacts, and security preferences for this browser wallet.
            </p>
            <Input
              type="password"
              value={backupPassword}
              onChange={(event) => {
                setBackupPassword(event.target.value);
                setBackupError("");
              }}
              placeholder="Backup password"
            />
            <Input
              type="password"
              value={backupConfirm}
              onChange={(event) => {
                setBackupConfirm(event.target.value);
                setBackupError("");
              }}
              placeholder="Confirm backup password"
            />
            {backupError && <p className="text-xs text-red-400">{backupError}</p>}
            {backupStatus && <p className="text-xs text-emerald-400">{backupStatus}</p>}
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={handleExportBackup}
              disabled={isExportingBackup}
            >
              {isExportingBackup ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download encrypted backup
            </Button>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Restore from encrypted backup
            </p>
          </div>
          <div className="space-y-3 p-4">
            <label className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/60 px-4 py-4 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors">
              <FileUp className="h-4 w-4" />
              Choose encrypted backup JSON
              <input type="file" accept="application/json,.json" className="hidden" onChange={handleImportFile} />
            </label>
            <textarea
              value={importBackupJson}
              onChange={(event) => {
                setImportBackupJson(event.target.value);
                setImportPreview(null);
                setImportError("");
                setImportStatus("");
              }}
              placeholder='{"kind":"vaulkyrie-wallet-backup", ...}'
              className="min-h-32 w-full rounded-xl border border-border bg-background px-3 py-3 text-xs font-mono text-foreground placeholder:text-muted-foreground/50"
            />
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="password"
                value={importBackupPassword}
                onChange={(event) => {
                  setImportBackupPassword(event.target.value);
                  setImportPreview(null);
                  setImportError("");
                }}
                placeholder="Password used when exporting this backup"
                className="pl-10"
              />
            </div>
            {importPreview && (
              <div className="rounded-xl border border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground space-y-2">
                <p className="text-sm font-medium text-foreground">Backup preview</p>
                <p>Exported: {new Date(importPreview.exportedAt).toLocaleString()}</p>
                <p>Network: {importPreview.network}</p>
                <p>Relay: {importPreview.relayUrl}</p>
                <p>
                  Accounts: {importPreview.accounts.map((account) => `${account.name} (${shortenAddress(account.publicKey)})`).join(", ")}
                </p>
                <p>
                  Contacts: {importPreview.contactCount} · Policies: {importPreview.policyProfileCount} · Activity: {importPreview.orchestrationActivityCount} · Recovery sessions: {importPreview.recoverySessionCount}
                </p>
              </div>
            )}
            {importError && <p className="text-xs text-red-400">{importError}</p>}
            {importStatus && <p className="text-xs text-emerald-400">{importStatus}</p>}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button variant="outline" className="gap-2" onClick={handlePreviewImport} disabled={previewingImport || importingBackup}>
                {previewingImport ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                Preview backup
              </Button>
              <Button className="gap-2" onClick={handleRestoreImport} disabled={importingBackup}>
                {importingBackup ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Restore backup now
              </Button>
            </div>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Onchain recovery coordination
            </p>
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => void handleRefreshSessions()} disabled={refreshingSessions || loadingSessions}>
              {refreshingSessions || loadingSessions ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
          <div className="space-y-4 p-4">
            <div className="rounded-xl border border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
              Start recovery when the current signer set can still authorize moving control to a new threshold group. Complete recovery after you have the recovered group public key and a fresh authority hash from the new device set.
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Expiry window</p>
                <Input value={expirySlotsInput} onChange={(event) => setExpirySlotsInput(event.target.value)} placeholder="500" />
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">New threshold</p>
                <Input value={newThresholdInput} onChange={(event) => setNewThresholdInput(event.target.value)} placeholder="2" />
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Participants</p>
                <Input value={newParticipantCountInput} onChange={(event) => setNewParticipantCountInput(event.target.value)} placeholder="3" />
              </div>
            </div>

            <Button className="w-full gap-2" onClick={handleStageRecovery} disabled={stagingRecovery || !activeAccount}>
              {stagingRecovery ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Stage recovery coordination
            </Button>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Tracked recovery sessions</p>
                <Badge variant="outline">{sessions.length}</Badge>
              </div>
              {sessions.length === 0 ? (
                <div className="rounded-xl border border-border bg-card/60 px-3 py-4 text-xs text-muted-foreground">
                  No recovery coordination has been staged for {activeAccount ? shortenAddress(activeAccount.publicKey) : "this vault"} yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {sessions.map((session) => {
                    const isSelected = selectedRecoveryId === session.id;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => {
                          setSelectedRecoveryId(session.id);
                          setCompleteGroupKeyInput(session.newGroupKey ?? "");
                          setCompleteAuthorityHashInput(session.newAuthorityHash ?? "");
                        }}
                        className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                          isSelected ? "border-primary bg-primary/5" : "border-border bg-card/60 hover:border-primary/30"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <p className="text-sm font-medium">Recovery {shortenAddress(session.recoveryAccount)}</p>
                            <p className="text-[11px] text-muted-foreground">
                              Expires at slot {session.expirySlot} · {session.newThreshold}-of-{session.newParticipantCount}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              Updated {new Date(session.updatedAt).toLocaleString()}
                            </p>
                          </div>
                          <Badge variant={sessionTone(session.status)}>{session.status}</Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span>Commitment {session.recoveryCommitment.slice(0, 12)}...</span>
                          <a
                            href={addressExplorerUrl(session.recoveryAccount, session.network)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            Explorer <ExternalLink className="h-3 w-3" />
                          </a>
                          {session.initSignature && (
                            <a
                              href={transactionExplorerUrl(session.initSignature, session.network)}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                              onClick={(event) => event.stopPropagation()}
                            >
                              Init tx <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                          {session.completeSignature && (
                            <a
                              href={transactionExplorerUrl(session.completeSignature, session.network)}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                              onClick={(event) => event.stopPropagation()}
                            >
                              Complete tx <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border bg-card/60 p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Complete selected recovery</p>
                <Badge variant="outline">{selectedSession ? shortenAddress(selectedSession.recoveryAccount) : "Select one"}</Badge>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Recovered group public key
                </p>
                <Input
                  value={completeGroupKeyInput}
                  onChange={(event) => setCompleteGroupKeyInput(event.target.value)}
                  placeholder="Base58 or 64-char hex"
                />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Recovered authority hash
                  </p>
                  <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={handleGenerateAuthorityHash} disabled={generatingAuthorityHash}>
                    {generatingAuthorityHash ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    Generate
                  </Button>
                </div>
                <Input
                  value={completeAuthorityHashInput}
                  onChange={(event) => setCompleteAuthorityHashInput(event.target.value)}
                  placeholder="Base58 or 64-char hex"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Generate stores a fresh local XMSS tree under the recovered group key so this device can later manage Vaulkyrie authority actions for the new vault.
              </p>
              <Button className="w-full gap-2" onClick={handleCompleteRecovery} disabled={!selectedSession || completingRecovery}>
                {completingRecovery ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                Complete recovery onchain
              </Button>
            </div>
          </div>
        </Card>

        <Card className="p-4 text-xs text-muted-foreground">
          <p>
            Active vault: {activeAccount ? `${activeAccount.name} (${shortenAddress(activeAccount.publicKey)})` : "Locked"} ·
            Network: {NETWORKS[network].name} · Contacts: {contacts.length} · Policies: {Object.values(policyProfiles).reduce((sum, profiles) => sum + profiles.length, 0)} · Activity records: {Object.values(orchestrationHistory).reduce((sum, history) => sum + history.length, 0)} · Auto-lock: {securityPreferences.autoLockMinutes}m
          </p>
        </Card>
      </motion.div>
    </div>
  );
}
