import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import {
  Shield, ShieldCheck, ShieldAlert, ShieldX,
  Loader2, RefreshCw, Clock, Plus, XCircle, AlertCircle, Check, ExternalLink, Radio,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWalletStore } from "@/store/walletStore";
import { PolicyMxeClient, findPolicyConfigPda, findPolicyEvaluationPda } from "@/sdk/policyClient";
import {
  VAULKYRIE_POLICY_MXE_PROGRAM_ID,
  VAULKYRIE_CORE_PROGRAM_ID,
  PolicyEvaluationStatus,
} from "@/sdk/constants";
import {
  createInitPolicyConfigInstruction,
  createOpenPolicyEvaluationInstruction,
  createAbortPolicyEvaluationInstruction,
  createFinalizePolicyEvaluationInstruction,
} from "@/sdk/policyInstructions";
import {
  ARCIUM_DEVNET_CLUSTER_OFFSET,
  assertPolicyEvaluateArciumReady,
  createQueuePolicyEvaluateInstruction,
  derivePolicyMxeAccount,
  encryptPolicyEvaluateInput,
  nextPolicyComputationOffset,
} from "@/sdk/arciumPolicy";
import { hexToBytes } from "@/services/frost/frostService";
import { SigningOrchestrator } from "@/services/frost/signingOrchestrator";
import {
  loadDkgResult,
  prepareLegacyVaultTransaction,
  sendSignedLegacyVaultTransaction,
  signAndSendTransaction,
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
import { requestCosignerSignature, type VaultCosignerMetadata } from "@/services/cosigner/cosignerClient";
import { NETWORKS } from "@/lib/constants";
import { withRpcFallback } from "@/services/solanaRpc";
import type { WalletView, PolicyProfile, PendingPolicyRequest } from "@/types";
import type { PolicyConfigAccount, PolicyEvaluationAccount } from "@/sdk/types";
import {
  buildWalletPolicyActionHash,
  buildWalletPolicyActionPayload,
  buildWalletPolicyInputCommitment,
  buildWalletPolicyResultCommitment,
} from "@/sdk/policyBindings";

interface PolicyViewProps {
  onNavigate: (view: WalletView) => void;
}

type PolicyPhase =
  | "dashboard"
  | "init-config"
  | "create-profile"
  | "open-eval"
  | "submitting"
  | "coordinate"
  | "success"
  | "error";

type BufferedSigningMessage =
  | { type: "round1"; fromId: number; commitments: number[] }
  | { type: "round2"; fromId: number; share: number[] };

function statusIcon(status: PolicyEvaluationStatus) {
  switch (status) {
    case PolicyEvaluationStatus.Pending:
      return <Clock className="h-4 w-4 text-amber-400" />;
    case PolicyEvaluationStatus.Finalized:
      return <ShieldCheck className="h-4 w-4 text-emerald-400" />;
    case PolicyEvaluationStatus.Aborted:
      return <ShieldX className="h-4 w-4 text-red-400" />;
    case PolicyEvaluationStatus.ComputationQueued:
      return <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />;
    default:
      return <ShieldAlert className="h-4 w-4 text-muted-foreground" />;
  }
}

function statusColor(status: PolicyEvaluationStatus): string {
  switch (status) {
    case PolicyEvaluationStatus.Pending:
      return "text-amber-400";
    case PolicyEvaluationStatus.Finalized:
      return "text-emerald-400";
    case PolicyEvaluationStatus.Aborted:
      return "text-red-400";
    case PolicyEvaluationStatus.ComputationQueued:
      return "text-blue-400";
    default:
      return "text-muted-foreground";
  }
}

function shortenHash(hash: Uint8Array): string {
  const hex = Array.from(hash.slice(0, 6))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex}…`;
}

function formatApprovalMode(mode: PolicyProfile["approvalMode"]): string {
  switch (mode) {
    case "allow":
      return "Auto-allow";
    case "review":
      return "Manual review";
    case "block":
      return "Block";
    default:
      return mode;
  }
}

function normalizeRecipients(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
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

export function PolicyView({ onNavigate }: PolicyViewProps) {
  const {
    activeAccount,
    network,
    relayUrl,
    vaultConfigs,
    policyProfiles,
    upsertPolicyProfile,
    deletePolicyProfile,
    pendingPolicyRequest,
    setPendingPolicyRequest,
  } = useWalletStore();
  const [config, setConfig] = useState<PolicyConfigAccount | null>(null);
  const [evaluations, setEvaluations] = useState<
    { address: PublicKey; account: PolicyEvaluationAccount }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [phase, setPhase] = useState<PolicyPhase>("dashboard");
  const [actionMsg, setActionMsg] = useState("");
  const [txSignature, setTxSignature] = useState("");
  const [signingSessionCode, setSigningSessionCode] = useState("");
  const [relaySessionInfo, setRelaySessionInfo] = useState(() => createRelaySessionMetadata("------"));
  const [abortingEval, setAbortingEval] = useState<string | null>(null);
  const [queueingEval, setQueueingEval] = useState<string | null>(null);
  const [finalizingEval, setFinalizingEval] = useState<string | null>(null);
  const [finalizeModes, setFinalizeModes] = useState<Record<string, "allow" | "review" | "block">>({});
  const [finalizeDelaySlots, setFinalizeDelaySlots] = useState<Record<string, string>>({});

  const [initVersion, setInitVersion] = useState("1");

  const [profileName, setProfileName] = useState("");
  const [profileActionType, setProfileActionType] = useState<PolicyProfile["actionType"]>("send");
  const [profileApprovalMode, setProfileApprovalMode] = useState<PolicyProfile["approvalMode"]>("review");
  const [profileTokenSymbol, setProfileTokenSymbol] = useState("SOL");
  const [profileMaxAmount, setProfileMaxAmount] = useState("");
  const [profileRecipients, setProfileRecipients] = useState("");
  const [profileNotes, setProfileNotes] = useState("");

  const [evalExpirySlots, setEvalExpirySlots] = useState("200");
  const [evalActionType, setEvalActionType] = useState<PolicyProfile["actionType"]>("send");
  const [evalRecipient, setEvalRecipient] = useState("");
  const [evalAmount, setEvalAmount] = useState("");
  const [evalToken, setEvalToken] = useState("SOL");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const relayRef = useRef<RelayAdapter | null>(null);
  const orchestratorRef = useRef<SigningOrchestrator | null>(null);
  const pendingSigningMessagesRef = useRef<BufferedSigningMessage[]>([]);
  const signingTimeoutRef = useRef<number | null>(null);

  const savedProfiles = useMemo(
    () => (activeAccount?.publicKey ? policyProfiles[activeAccount.publicKey] ?? [] : []),
    [activeAccount?.publicKey, policyProfiles],
  );
  const selectedProfile = savedProfiles.find((profile) => profile.id === selectedProfileId) ?? null;

  const seedEvaluationDraft = useCallback((request: PendingPolicyRequest) => {
    setSelectedProfileId(request.profileId);
    setEvalActionType(request.actionType);
    setEvalRecipient(request.recipient);
    setEvalAmount(request.amount.toString());
    setEvalToken(request.tokenSymbol);
  }, []);

  useEffect(() => {
    if (!savedProfiles.length) {
      if (selectedProfileId) setSelectedProfileId("");
      return;
    }
    if (!selectedProfileId || !savedProfiles.some((profile) => profile.id === selectedProfileId)) {
      setSelectedProfileId(savedProfiles[0].id);
    }
  }, [savedProfiles, selectedProfileId]);

  useEffect(() => {
    if (!pendingPolicyRequest) return;
    seedEvaluationDraft(pendingPolicyRequest);
  }, [pendingPolicyRequest, seedEvaluationDraft]);

  const fetchPolicyData = useCallback(async () => {
    if (!activeAccount?.publicKey) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");

    try {
      const pubkey = new PublicKey(activeAccount.publicKey);
      const result = await withRpcFallback(network, async (connection) => {
        const client = new PolicyMxeClient(connection);
        const configResult = await client.getPolicyConfig(pubkey);

        if (!configResult) {
          return { config: null, evaluations: [] };
        }

        const evaluations = await client.getEvaluationsForVault(pubkey);
        return { config: configResult.account, evaluations };
      });

      setConfig(result.config);
      setEvaluations(result.evaluations);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to fetch policy data");
    } finally {
      setLoading(false);
    }
  }, [activeAccount?.publicKey, network]);

  useEffect(() => {
    fetchPolicyData();
  }, [fetchPolicyData]);

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

  const runMultiDevicePolicySigning = useCallback(async (params: {
    participantId: number;
    keyPackageJson: string;
    publicKeyPackageJson: string;
    threshold: number;
    cosigner?: VaultCosignerMetadata | null;
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
        deviceName: `Policy signer ${params.participantId}`,
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
                setActionMsg("Preparing policy transaction...");
                const message = await params.prepareMessage();
                const request: SignRequestPayload = {
                  requestId: crypto.randomUUID(),
                  message: Array.from(message),
                  signerIds,
                  amount: 0,
                  token: "POLICY",
                  recipient: activeAccount?.publicKey ?? "",
                  initiator: activeAccount?.name ?? `Policy signer ${params.participantId}`,
                  network,
                  createdAt: Date.now(),
                  purpose: "policy",
                  summary: params.summary,
                };

                relay.broadcastSignRequest(request);
                setActionMsg("Policy signing request sent. Waiting for signer approvals...");
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
              } catch (err) {
                settle(() => reject(err));
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
                ? "Connected to relay. Creating secure policy signing invite..."
                : "Connected to relay. Waiting for another signer...",
            );
            relay.createSession(params.threshold, params.threshold, requestedSessionCode);
          } else if (state === "failed") {
            settle(() => reject(new Error("Relay connection failed")));
          }
        },
        onSessionCreated: (session) => {
          setActionMsg(
            params.cosigner?.enabled
              ? `Policy signing session created. Requesting ${params.cosigner.label}...`
              : `Policy signing session created: ${session.invite}. Share with another signer.`,
          );
          setSigningSessionCode(session.invite);
          setRelaySessionInfo(session);
          if (params.cosigner?.enabled) {
            void requestCosignerSignature({ cosigner: params.cosigner, relayUrl, session })
              .then((accepted) => {
                if (accepted && params.cosigner) {
                  setActionMsg(`${params.cosigner.label} is joining the policy signing session...`);
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
        settle(() => reject(new Error("Policy signing timed out. Not enough signers connected within 2 minutes.")));
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

  const signAndSendPolicyTransaction = useCallback(async (
    connection: Connection,
    tx: Transaction,
    summary: string,
  ): Promise<string> => {
    if (!activeAccount?.publicKey) {
      throw new Error("No active vault selected.");
    }

    const dkg = loadDkgResult(activeAccount.publicKey);
    const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
    const hasLocalThreshold = availableKeyIds.length >= dkg.threshold;
    const isMultiDevice = dkg.isMultiDevice === true;

    if (hasLocalThreshold && !isMultiDevice) {
      return signAndSendTransaction(connection, tx, activeAccount.publicKey, setActionMsg);
    }

    const participantId = dkg.participantId ?? availableKeyIds[0] ?? 1;
    const keyPackageJson = dkg.keyPackages[participantId];
    if (!keyPackageJson) {
      throw new Error(`No key package found for participant ${participantId}.`);
    }

    const result = await runMultiDevicePolicySigning({
      participantId,
      keyPackageJson,
      publicKeyPackageJson: dkg.publicKeyPackage,
      threshold: dkg.threshold,
      cosigner: dkg.cosigner ?? null,
      prepareMessage: async () => {
        await prepareLegacyVaultTransaction(connection, tx, activeAccount.publicKey);
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
  }, [activeAccount?.publicKey, runMultiDevicePolicySigning]);

  const resetProfileForm = useCallback(() => {
    setProfileName("");
    setProfileActionType("send");
    setProfileApprovalMode("review");
    setProfileTokenSymbol("SOL");
    setProfileMaxAmount("");
    setProfileRecipients("");
    setProfileNotes("");
  }, []);

  const handleSaveProfile = () => {
    if (!activeAccount?.publicKey) return;
    const trimmedName = profileName.trim();
    if (!trimmedName) {
      setError("Give this policy a name first.");
      setPhase("error");
      return;
    }

    const now = Date.now();
    const maxAmountValue = profileMaxAmount.trim() ? Number(profileMaxAmount) : null;
    if (maxAmountValue !== null && Number.isNaN(maxAmountValue)) {
      setError("Max amount must be a valid number.");
      setPhase("error");
      return;
    }

    upsertPolicyProfile(activeAccount.publicKey, {
      id: crypto.randomUUID(),
      name: trimmedName,
      actionType: profileActionType,
      approvalMode: profileApprovalMode,
      tokenSymbol: profileTokenSymbol.trim().toUpperCase() || "SOL",
      maxAmount: maxAmountValue,
      allowedRecipients: normalizeRecipients(profileRecipients),
      notes: profileNotes.trim(),
      createdAt: now,
      updatedAt: now,
    });

    resetProfileForm();
    setPhase("dashboard");
  };

  const handleDeleteProfile = (profileId: string) => {
    if (!activeAccount?.publicKey) return;
    deletePolicyProfile(activeAccount.publicKey, profileId);
  };

  const handleInitConfig = async () => {
    if (!activeAccount?.publicKey) return;
    setPhase("submitting");
    setActionMsg("Deriving policy config PDA...");

    try {
      const authority = new PublicKey(activeAccount.publicKey);
      const [configPda, bump] = findPolicyConfigPda(authority);

      setActionMsg("Building init_policy_config transaction...");
      const sig = await withRpcFallback(network, async (connection) => {
        const ix = createInitPolicyConfigInstruction(configPda, authority, {
          coreProgram: VAULKYRIE_CORE_PROGRAM_ID.toBytes(),
          arciumProgram: VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBytes(),
          mxeAccount: derivePolicyMxeAccount().toBytes(),
          policyVersion: BigInt(initVersion || "1"),
          bump,
        });

        const tx = new Transaction().add(ix);

        return signAndSendPolicyTransaction(
          connection,
          tx,
          "Initialize the policy bridge for this vault.",
        );
      });

      setTxSignature(sig);
      setPhase("success");
      fetchPolicyData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to initialize policy config");
      setPhase("error");
    }
  };

  const handleOpenEvaluation = useCallback(async () => {
    if (!activeAccount?.publicKey || !config) return;
    setPhase("submitting");
    setActionMsg("Building evaluation request...");

    try {
      const authority = new PublicKey(activeAccount.publicKey);
      if (evalActionType === "send" && evalRecipient.trim()) {
        new PublicKey(evalRecipient.trim());
      }

      const [configPda] = findPolicyConfigPda(authority);
      const nonce = config.nextRequestNonce;

      const actionPayload = buildWalletPolicyActionPayload({
        profile: selectedProfile,
        actionType: evalActionType,
        recipient: evalRecipient,
        amount: Number(evalAmount || "0"),
        token: evalToken,
      });
      const actionHash = await buildWalletPolicyActionHash(actionPayload);
      const encryptedInput = await buildWalletPolicyInputCommitment({
        policyProfile: selectedProfile,
        actionPayload,
      });
      const [evalPda] = findPolicyEvaluationPda(configPda, actionHash);

      setActionMsg("Building open_policy_evaluation transaction...");
      const sig = await withRpcFallback(network, async (connection) => {
        const currentSlot = await connection.getSlot();
        const expirySlot = BigInt(currentSlot) + BigInt(evalExpirySlots || "200");

        const ix = createOpenPolicyEvaluationInstruction(
          configPda,
          evalPda,
          authority,
          {
            vaultId: authority.toBytes(),
            actionHash,
            encryptedInputCommitment: encryptedInput,
            requestNonce: nonce,
            expirySlot,
            computationOffset: 0n,
          },
        );

        const tx = new Transaction().add(ix);

        return signAndSendPolicyTransaction(
          connection,
          tx,
          `Open policy evaluation for ${evalActionType} ${evalAmount || "0"} ${evalToken}.`,
        );
      });

      setPendingPolicyRequest(null);
      setTxSignature(sig);
      setPhase("success");
      fetchPolicyData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open evaluation");
      setPhase("error");
    }
  }, [activeAccount?.publicKey, config, evalActionType, evalAmount, evalExpirySlots, evalRecipient, evalToken, fetchPolicyData, network, selectedProfile, setPendingPolicyRequest, signAndSendPolicyTransaction]);

  const handleAbortEvaluation = async (evalAddress: PublicKey) => {
    if (!activeAccount?.publicKey) return;
    setAbortingEval(evalAddress.toBase58());

    try {
      const authority = new PublicKey(activeAccount.publicKey);
      await withRpcFallback(network, async (connection) => {
        const ix = createAbortPolicyEvaluationInstruction(
          evalAddress,
          authority,
          1,
        );

        const tx = new Transaction().add(ix);

        return signAndSendPolicyTransaction(
          connection,
          tx,
          "Abort this pending policy evaluation.",
        );
      });

      fetchPolicyData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to abort evaluation");
    } finally {
      setAbortingEval(null);
    }
  };

  const handleQueueEvaluation = async (
    evalAddress: PublicKey,
    evaluation: PolicyEvaluationAccount,
  ) => {
    if (!activeAccount?.publicKey) return;
    setQueueingEval(evalAddress.toBase58());
    setActionMsg("Queueing Arcium computation...");

    try {
      if (network !== "devnet") {
        throw new Error("Arcium policy queue is currently configured for devnet cluster offset 456.");
      }

      const authority = new PublicKey(activeAccount.publicKey);

      await withRpcFallback(network, async (connection) => {
        const computationOffset = nextPolicyComputationOffset();
        setActionMsg("Checking Arcium MXE accounts...");
        await assertPolicyEvaluateArciumReady(
          connection,
          computationOffset,
          ARCIUM_DEVNET_CLUSTER_OFFSET,
        );

        setActionMsg("Encrypting policy input for Arcium...");
        const encryptedInput = await encryptPolicyEvaluateInput(
          connection,
          authority,
          evaluation,
        );

        setActionMsg("Building queue_policy_evaluate transaction...");
        const ix = createQueuePolicyEvaluateInstruction(evalAddress, authority, {
          computationOffset,
          encryptedInput: encryptedInput.encryptedInput,
          x25519Pubkey: encryptedInput.x25519Pubkey,
          nonce: encryptedInput.nonce,
          clusterOffset: ARCIUM_DEVNET_CLUSTER_OFFSET,
        });

        const tx = new Transaction().add(ix);

        return signAndSendPolicyTransaction(
          connection,
          tx,
          "Queue this policy evaluation for Arcium processing.",
        );
      });

      await fetchPolicyData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to queue Arcium computation");
      setPhase("error");
    } finally {
      setQueueingEval(null);
    }
  };

  const handleFinalizeEvaluation = async (
    evalAddress: PublicKey,
    evaluation: PolicyEvaluationAccount,
  ) => {
    if (!activeAccount?.publicKey) return;
    const evalKey = evalAddress.toBase58();
    const mode = finalizeModes[evalKey] ?? "allow";
    const delaySlots = Number(finalizeDelaySlots[evalKey] ?? "0");
    if (Number.isNaN(delaySlots) || delaySlots < 0) {
      setError("Finalize delay must be zero or a positive number.");
      return;
    }

    setFinalizingEval(evalKey);
    setActionMsg("Finalizing policy decision...");

    try {
      const authority = new PublicKey(activeAccount.publicKey);
      const configuredThreshold = vaultConfigs[activeAccount.publicKey]?.threshold ?? 1;
      const reasonCode = mode === "allow" ? 0 : 1;

      if (mode === "block") {
        await withRpcFallback(network, async (connection) => {
          const ix = createAbortPolicyEvaluationInstruction(
            evalAddress,
            authority,
            2,
          );

          const tx = new Transaction().add(ix);

          return signAndSendPolicyTransaction(
            connection,
            tx,
            "Finalize this policy evaluation as blocked.",
          );
        });

        await fetchPolicyData();
        return;
      }

      const resultCommitment = await buildWalletPolicyResultCommitment({
        mode,
        reasonCode,
        actionHash: evaluation.actionHash,
        computationOffset: evaluation.computationOffset,
      });

      await withRpcFallback(network, async (connection) => {
        const currentSlot = await connection.getSlot();
        const ix = createFinalizePolicyEvaluationInstruction(
          evalAddress,
          authority,
          {
            requestCommitment: evaluation.requestCommitment,
            actionHash: evaluation.actionHash,
            policyVersion: evaluation.policyVersion,
            threshold: configuredThreshold,
            nonce: evaluation.requestNonce,
            receiptExpirySlot: evaluation.expirySlot,
            delayUntilSlot: BigInt(currentSlot + delaySlots),
            reasonCode,
            computationOffset: evaluation.computationOffset,
            resultCommitment,
          },
        );

        const tx = new Transaction().add(ix);

        return signAndSendPolicyTransaction(
          connection,
          tx,
          `Finalize this policy evaluation as ${mode}.`,
        );
      });

      await fetchPolicyData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to finalize evaluation");
      setPhase("error");
    } finally {
      setFinalizingEval(null);
    }
  };

  if (phase === "success") {
    const explorerBase = NETWORKS[network]?.explorerUrl ?? "https://explorer.solana.com";
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-6 flex-1">
        <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
          <Check className="h-8 w-8 text-emerald-400" />
        </div>
        <h3 className="text-lg font-semibold">Transaction Submitted</h3>
        {txSignature && (
          <a
            href={`${explorerBase}/tx/${txSignature}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:underline flex items-center gap-1"
          >
            View on Explorer <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <Button
          onClick={() => { setPhase("dashboard"); setTxSignature(""); }}
          className="mt-4"
        >
          Back to Policy Dashboard
        </Button>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-6 flex-1">
        <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center">
          <AlertCircle className="h-8 w-8 text-red-400" />
        </div>
        <h3 className="text-lg font-semibold">Action Failed</h3>
        <p className="text-sm text-muted-foreground text-center max-w-[280px]">{error}</p>
        <Button
          onClick={() => { setPhase("dashboard"); setError(""); }}
          variant="outline"
          className="mt-4"
        >
          Try Again
        </Button>
      </div>
    );
  }

  if (phase === "submitting") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-6 flex-1">
        <Loader2 className="h-10 w-10 text-primary animate-spin" />
        <p className="text-sm text-muted-foreground text-center max-w-[260px]">{actionMsg}</p>
      </div>
    );
  }

  if (phase === "coordinate") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-6 flex-1">
        <div className="relative mb-2">
          <div className="absolute -inset-4 bg-orange-500/20 rounded-full blur-xl animate-pulse" />
          <div className="relative h-16 w-16 rounded-full bg-orange-500/15 border-2 border-orange-500/40 flex items-center justify-center">
            <Radio className="h-8 w-8 text-orange-400 animate-pulse" />
          </div>
        </div>
        <h3 className="text-base font-semibold">Policy Signing</h3>
        {signingSessionCode && (
          <div className="flex flex-col items-center gap-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
              {relaySessionInfo.authToken ? "Session Invite" : "Session Code"}
            </p>
            <code className={`font-mono font-bold text-primary bg-primary/10 px-4 py-1.5 rounded-lg select-all ${
              relaySessionInfo.authToken ? "text-xs tracking-wide" : "text-lg tracking-[.3em]"
            }`}>
              {signingSessionCode}
            </code>
            <p className="text-[10px] text-muted-foreground mt-1">
              Share this {relaySessionInfo.authToken ? "invite" : "code"} with another vault signer
            </p>
            <p className="text-[11px] text-muted-foreground">
              Verify phrase: <span className="font-mono text-foreground">{relaySessionInfo.verificationPhrase}</span>
            </p>
          </div>
        )}
        <p className="text-xs text-muted-foreground text-center max-w-[280px]">
          {actionMsg}
        </p>
      </div>
    );
  }

  if (phase === "create-profile") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setPhase("dashboard")}
            className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
          >
            ← Back
          </button>
          <h2 className="text-lg font-semibold flex-1 text-center mr-8">Create Policy Profile</h2>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <div>
              <label htmlFor="policy-profile-name" className="text-xs text-muted-foreground mb-1 block">Policy name</label>
              <Input
                id="policy-profile-name"
                name="policyProfileName"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                placeholder="Daily transfers under 1 SOL"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="policy-profile-action-type" className="text-xs text-muted-foreground mb-1 block">Action type</label>
                <select
                  id="policy-profile-action-type"
                  name="policyProfileActionType"
                  value={profileActionType}
                  onChange={(event) => setProfileActionType(event.target.value as PolicyProfile["actionType"])}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="send">Send</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label htmlFor="policy-profile-decision" className="text-xs text-muted-foreground mb-1 block">Decision</label>
                <select
                  id="policy-profile-decision"
                  name="policyProfileDecision"
                  value={profileApprovalMode}
                  onChange={(event) => setProfileApprovalMode(event.target.value as PolicyProfile["approvalMode"])}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="allow">Auto-allow</option>
                  <option value="review">Manual review</option>
                  <option value="block">Block</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="policy-profile-token" className="text-xs text-muted-foreground mb-1 block">Token</label>
                <Input
                  id="policy-profile-token"
                  name="policyProfileToken"
                  value={profileTokenSymbol}
                  onChange={(event) => setProfileTokenSymbol(event.target.value.toUpperCase())}
                  placeholder="SOL"
                />
              </div>
              <div>
                <label htmlFor="policy-profile-max-amount" className="text-xs text-muted-foreground mb-1 block">Max amount</label>
                <Input
                  id="policy-profile-max-amount"
                  name="policyProfileMaxAmount"
                  type="number"
                  value={profileMaxAmount}
                  onChange={(event) => setProfileMaxAmount(event.target.value)}
                  placeholder="1.0"
                  min="0"
                  max="1000000000"
                  step="any"
                />
              </div>
            </div>

            <div>
              <label htmlFor="policy-profile-recipients" className="text-xs text-muted-foreground mb-1 block">Allowed recipients</label>
              <textarea
                id="policy-profile-recipients"
                name="policyProfileRecipients"
                value={profileRecipients}
                onChange={(event) => setProfileRecipients(event.target.value)}
                placeholder="One address per line or comma-separated"
                className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label htmlFor="policy-profile-notes" className="text-xs text-muted-foreground mb-1 block">Notes</label>
              <textarea
                id="policy-profile-notes"
                name="policyProfileNotes"
                value={profileNotes}
                onChange={(event) => setProfileNotes(event.target.value)}
                placeholder="Describe why this rule exists or what it protects."
                className="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <Button onClick={handleSaveProfile} className="w-full">
              <Shield className="h-4 w-4 mr-2" />
              Save policy profile
            </Button>
          </CardContent>
        </Card>

        <div className="bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
          <p className="font-medium text-foreground/70 mb-1">What this saves</p>
          <p>
            Policy profiles live inside the wallet and capture the rule you want reviewers or the
            private Arcium flow to evaluate later. They make the dashboard usable now, even before
            every encrypted MXE path is fully wired into each transaction flow.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "init-config") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setPhase("dashboard")}
            className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
          >
            ← Back
          </button>
          <h2 className="text-lg font-semibold flex-1 text-center mr-8">Initialize Policy Bridge</h2>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <div>
              <label htmlFor="policy-init-version" className="text-xs text-muted-foreground mb-1 block">Policy version</label>
              <Input
                id="policy-init-version"
                name="policyInitVersion"
                type="number"
                value={initVersion}
                onChange={(event) => setInitVersion(event.target.value)}
                placeholder="1"
                min="1"
                max="1000000"
              />
            </div>

            <div className="space-y-2 text-[10px] text-muted-foreground">
              <div className="flex justify-between">
                <span>Core program</span>
                <span className="font-mono">{VAULKYRIE_CORE_PROGRAM_ID.toBase58().slice(0, 16)}…</span>
              </div>
              <div className="flex justify-between">
                <span>MXE program</span>
                <span className="font-mono">{VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBase58().slice(0, 16)}…</span>
              </div>
              <div className="flex justify-between">
                <span>Authority</span>
                <span className="font-mono">{activeAccount?.publicKey?.slice(0, 16)}…</span>
              </div>
            </div>

            <Button onClick={handleInitConfig} className="w-full">
              <Shield className="h-4 w-4 mr-2" />
              Initialize on-chain bridge
            </Button>
          </CardContent>
        </Card>

        <div className="bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
          <p className="font-medium text-foreground/70 mb-1">Advanced / devnet</p>
          <p>
            This initializes the raw policy bridge account used by the Arcium MXE program. It is the
            low-level on-chain setup step, separate from the human-readable policy profiles above.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "open-eval") {
    return (
      <div className="flex flex-col gap-4 p-4 flex-1">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setPhase("dashboard")}
            className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
          >
            ← Back
          </button>
          <h2 className="text-lg font-semibold flex-1 text-center mr-8">Open Evaluation</h2>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            {pendingPolicyRequest && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 text-[11px] text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">Prefilled from send flow</p>
                <p>
                  {pendingPolicyRequest.amount} {pendingPolicyRequest.tokenSymbol} to {pendingPolicyRequest.recipient}
                </p>
              </div>
            )}

            <div>
              <label htmlFor="policy-eval-profile" className="text-xs text-muted-foreground mb-1 block">Policy profile</label>
              <select
                id="policy-eval-profile"
                name="policyEvalProfile"
                value={selectedProfileId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setSelectedProfileId(nextId);
                  const nextProfile = savedProfiles.find((profile) => profile.id === nextId);
                  if (nextProfile) {
                    setEvalActionType(nextProfile.actionType);
                    setEvalToken(nextProfile.tokenSymbol);
                  }
                }}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">No saved profile</option>
                {savedProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="policy-eval-action-type" className="text-xs text-muted-foreground mb-1 block">Action type</label>
                <select
                  id="policy-eval-action-type"
                  name="policyEvalActionType"
                  value={evalActionType}
                  onChange={(event) => setEvalActionType(event.target.value as PolicyProfile["actionType"])}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="send">Send</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label htmlFor="policy-eval-expiry-slots" className="text-xs text-muted-foreground mb-1 block">Expiry (slots)</label>
                <Input
                  id="policy-eval-expiry-slots"
                  name="policyEvalExpirySlots"
                  type="number"
                  value={evalExpirySlots}
                  onChange={(event) => setEvalExpirySlots(event.target.value)}
                  placeholder="200"
                  min="10"
                  max="1000000"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="policy-eval-token" className="text-xs text-muted-foreground mb-1 block">Token</label>
                <Input
                  id="policy-eval-token"
                  name="policyEvalToken"
                  value={evalToken}
                  onChange={(event) => setEvalToken(event.target.value.toUpperCase())}
                  placeholder="SOL"
                />
              </div>
              <div>
                <label htmlFor="policy-eval-amount" className="text-xs text-muted-foreground mb-1 block">Amount</label>
                <Input
                  id="policy-eval-amount"
                  name="policyEvalAmount"
                  type="number"
                  value={evalAmount}
                  onChange={(event) => setEvalAmount(event.target.value)}
                  placeholder="0.5"
                  min="0"
                  max="1000000000"
                  step="any"
                />
              </div>
            </div>

            <div>
              <label htmlFor="policy-eval-recipient" className="text-xs text-muted-foreground mb-1 block">Recipient / target</label>
              <Input
                id="policy-eval-recipient"
                name="policyEvalRecipient"
                value={evalRecipient}
                onChange={(event) => setEvalRecipient(event.target.value)}
                placeholder="Recipient address or admin target"
              />
            </div>

            {selectedProfile && (
              <div className="rounded-xl border border-border bg-background/60 px-3 py-3 text-[11px] text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">{selectedProfile.name}</p>
                <p>{formatApprovalMode(selectedProfile.approvalMode)} · {selectedProfile.actionType} · {selectedProfile.tokenSymbol}</p>
                <p>
                  Max amount: {selectedProfile.maxAmount ?? "No cap"} · Allowed recipients: {selectedProfile.allowedRecipients.length || "Any"}
                </p>
              </div>
            )}

            <Button onClick={handleOpenEvaluation} className="w-full">
              <Plus className="h-4 w-4 mr-2" />
              Open policy evaluation
            </Button>
          </CardContent>
        </Card>

        <div className="bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
          <p className="font-medium text-foreground/70 mb-1">What gets bound on-chain</p>
          <p>
            The wallet hashes the selected action summary and chosen policy profile into the evaluation
            request. That makes the request deterministic and reviewable instead of using a random test hash.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 flex-1">
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => onNavigate("dashboard")}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm cursor-pointer"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold flex-1 text-center mr-8 flex items-center justify-center gap-2">
          <Shield className="h-5 w-5" />
          Policy Engine
        </h2>
      </div>

      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="rounded-xl border border-primary/15 bg-primary/5 px-3 py-3 mb-4 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">How Arcium is wired here</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
              <div className="rounded-lg bg-background/70 px-3 py-2 border border-border">
                <p className="font-medium text-foreground">1. Local policy profiles</p>
                <p>Human-readable wallet rules for send/admin actions.</p>
              </div>
              <div className="rounded-lg bg-background/70 px-3 py-2 border border-border">
                <p className="font-medium text-foreground">2. On-chain bridge</p>
                <p>Creates the MXE-linked config PDA on devnet.</p>
              </div>
              <div className="rounded-lg bg-background/70 px-3 py-2 border border-border">
                <p className="font-medium text-foreground">3. Evaluation request</p>
                <p>Binds an action summary and policy commitment on-chain.</p>
              </div>
              <div className="rounded-lg bg-background/70 px-3 py-2 border border-border">
                <p className="font-medium text-foreground">4. Queue computation</p>
                <p>Hands the request into the Arcium computation stage.</p>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-muted-foreground">Policy Profiles</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                resetProfileForm();
                setPhase("create-profile");
              }}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              New Profile
            </Button>
          </div>

          {savedProfiles.length === 0 ? (
            <div className="text-center py-4">
              <ShieldAlert className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm text-muted-foreground">No policy profiles saved yet</p>
              <p className="text-[10px] text-muted-foreground/70 mt-1">
                Create reusable rules for send and admin actions so reviewers know what to approve.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {savedProfiles.map((profile) => (
                <div key={profile.id} className="rounded-xl border border-border bg-background/60 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">{profile.name}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 ml-auto text-red-400 hover:text-red-300"
                      onClick={() => handleDeleteProfile(profile.id)}
                    >
                      <XCircle className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
                    <span>Action</span>
                    <span className="text-right">{profile.actionType}</span>
                    <span>Decision</span>
                    <span className="text-right">{formatApprovalMode(profile.approvalMode)}</span>
                    <span>Token / cap</span>
                    <span className="text-right">
                      {profile.tokenSymbol} / {profile.maxAmount ?? "No cap"}
                    </span>
                    <span>Recipients</span>
                    <span className="text-right">{profile.allowedRecipients.length || "Any"}</span>
                  </div>
                  {profile.notes && (
                    <p className="text-[10px] text-muted-foreground border-t border-border pt-2">
                      {profile.notes}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {pendingPolicyRequest && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="pt-4 pb-3 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Pending transfer review</span>
            </div>
            <p className="text-xs text-muted-foreground">
              A send flow handed off {pendingPolicyRequest.amount} {pendingPolicyRequest.tokenSymbol} to {pendingPolicyRequest.recipient} for policy evaluation.
            </p>
            <div className="flex gap-2">
              {config ? (
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    seedEvaluationDraft(pendingPolicyRequest);
                    setPhase("open-eval");
                  }}
                >
                  Open Draft
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => setPhase("init-config")}
                >
                  Initialize Bridge
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPendingPolicyRequest(null)}
              >
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-muted-foreground">On-Chain Policy Bridge</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchPolicyData}
              disabled={loading}
              className="h-7 w-7 p-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-4 justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading policy state…</span>
            </div>
          ) : error ? (
            <div className="text-sm text-destructive py-2">{error}</div>
          ) : config ? (
            <div className="space-y-3">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Status</span>
                <span className="text-emerald-400 font-medium flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  Active
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Policy version</span>
                <span className="font-mono">{config.policyVersion.toString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Next nonce</span>
                <span className="font-mono">{config.nextRequestNonce.toString()}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">MXE program</span>
                <span className="font-mono text-[10px] truncate max-w-[140px]">
                  {VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBase58().slice(0, 12)}…
                </span>
              </div>
              <div className="rounded-lg border border-border bg-background/60 px-3 py-2 text-[10px] text-muted-foreground">
                {evaluations.some((ev) => ev.account.status === PolicyEvaluationStatus.ComputationQueued)
                  ? "Arcium queue step has been exercised for this vault. Wait for the bridge/callback side to finalize decisions."
                  : "Next test step: open an evaluation, then queue it into the Arcium computation stage."}
              </div>
            </div>
          ) : (
            <div className="text-center py-4">
              <ShieldAlert className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm text-muted-foreground">No on-chain bridge initialized</p>
              <Button
                onClick={() => setPhase("init-config")}
                variant="outline"
                size="sm"
                className="mt-3"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Initialize Bridge
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {config && (
        <div className="flex gap-2">
          <Button
            onClick={() => setPhase("open-eval")}
            variant="outline"
            size="sm"
            className="flex-1"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            New Evaluation
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Policy Evaluations</span>
        <span className="text-[10px] text-muted-foreground">
          {evaluations.length} total
        </span>
      </div>

      {evaluations.length === 0 && !loading ? (
        <Card>
          <CardContent className="py-6 text-center">
            <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
            <p className="text-sm text-muted-foreground">No evaluations yet</p>
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              {config
                ? "Create an evaluation from a saved policy profile to exercise the bridge."
                : "Create a policy profile now, then initialize the bridge when you want on-chain evaluations."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2 overflow-y-auto max-h-[320px]">
          {evaluations.map((ev) => (
            <Card key={ev.address.toBase58()}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center gap-2 mb-2">
                  {statusIcon(ev.account.status)}
                  <span className={`text-xs font-medium ${statusColor(ev.account.status)}`}>
                    {PolicyMxeClient.statusLabel(ev.account.status)}
                  </span>
                  {ev.account.reasonCode > 0 && (
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      Code: {ev.account.reasonCode}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
                  <span>Action hash</span>
                  <span className="font-mono text-right">{shortenHash(ev.account.actionHash)}</span>
                  <span>Policy ver.</span>
                  <span className="font-mono text-right">{ev.account.policyVersion.toString()}</span>
                  <span>Nonce</span>
                  <span className="font-mono text-right">{ev.account.requestNonce.toString()}</span>
                  <span>Expiry slot</span>
                  <span className="font-mono text-right">{ev.account.expirySlot.toString()}</span>
                  <span>Computation offset</span>
                  <span className="font-mono text-right">{ev.account.computationOffset.toString()}</span>
                </div>
                {ev.account.status === PolicyEvaluationStatus.Pending && (
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleQueueEvaluation(ev.address, ev.account)}
                      disabled={queueingEval === ev.address.toBase58()}
                    >
                      {queueingEval === ev.address.toBase58() ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-3.5 w-3.5 mr-1" />
                      )}
                      Queue Arcium
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleAbortEvaluation(ev.address)}
                      disabled={abortingEval === ev.address.toBase58()}
                      className="text-red-400 hover:text-red-300"
                    >
                      {abortingEval === ev.address.toBase58() ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5" />
                      )}
                      <span className="text-[10px] ml-1">Abort</span>
                    </Button>
                  </div>
                )}
                {ev.account.status === PolicyEvaluationStatus.ComputationQueued && (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-lg border border-blue-400/20 bg-blue-400/5 px-3 py-2 text-[10px] text-muted-foreground">
                      This request has been queued into the Arcium stage. You can now finalize it from
                      the wallet with a deterministic prototype decision commitment while the full
                      private callback consumer is still being wired.
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label htmlFor={`policy-finalize-mode-${ev.address.toBase58()}`} className="text-[10px] text-muted-foreground mb-1 block">Decision mode</label>
                        <select
                          id={`policy-finalize-mode-${ev.address.toBase58()}`}
                          name={`policyFinalizeMode-${ev.address.toBase58()}`}
                          value={finalizeModes[ev.address.toBase58()] ?? "allow"}
                          onChange={(event) =>
                            setFinalizeModes((prev) => ({
                              ...prev,
                              [ev.address.toBase58()]: event.target.value as "allow" | "review" | "block",
                            }))
                          }
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                        >
                          <option value="allow">Allow</option>
                          <option value="review">Needs review</option>
                          <option value="block">Block</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`policy-finalize-delay-${ev.address.toBase58()}`} className="text-[10px] text-muted-foreground mb-1 block">Delay slots</label>
                        <Input
                          id={`policy-finalize-delay-${ev.address.toBase58()}`}
                          name={`policyFinalizeDelay-${ev.address.toBase58()}`}
                          type="number"
                          min="0"
                          max="1000000"
                          value={finalizeDelaySlots[ev.address.toBase58()] ?? "0"}
                          onChange={(event) =>
                            setFinalizeDelaySlots((prev) => ({
                              ...prev,
                              [ev.address.toBase58()]: event.target.value,
                            }))
                          }
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={() => handleFinalizeEvaluation(ev.address, ev.account)}
                      disabled={finalizingEval === ev.address.toBase58()}
                    >
                      {finalizingEval === ev.address.toBase58() ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5 mr-1" />
                      )}
                      Finalize decision
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-auto bg-primary/5 rounded-xl px-4 py-3 text-[10px] text-muted-foreground">
        <p className="font-medium text-foreground/70 mb-1">How to use this screen</p>
        <p>
          1. Create a local policy profile. 2. Initialize the on-chain bridge once per vault. 3. Open
          an evaluation from a send flow or manually here. 4. Queue the evaluation into the Arcium
          computation stage. 5. Finalize the queued result from the wallet while the bridge-side
          callback consumer remains the next integration step.
        </p>
      </div>
    </div>
  );
}
