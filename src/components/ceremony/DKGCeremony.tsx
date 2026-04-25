import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  QrCode,
  Smartphone,
  Monitor,
  Wifi,
  WifiOff,
  Check,
  Loader2,
  ArrowLeft,
  RefreshCw,
  Copy,
  Shield,
  AlertTriangle,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { VaultConfig } from "@/components/onboarding/VaultConfigStep";
import { runLocalDkg, hexToBytes } from "@/services/frost/frostService";
import type { LocalDkgProgress } from "@/services/frost/frostService";
import {
  createRelay,
  generateSessionCode,
  buildQrPayload,
  probeRelayAvailability,
  type RelayAdapter,
  type ConnectionState,
} from "@/services/relay/relayAdapter";
import type { RelayParticipant } from "@/services/relay/channelRelay";
import { createRelaySessionMetadata } from "@/services/relay/sessionInvite";
import {
  DkgOrchestrator,
  type DkgOrchestratorProgress,
} from "@/services/frost/dkgOrchestrator";
import { SigningOrchestrator } from "@/services/frost/signingOrchestrator";
import { signAndSendTransaction } from "@/services/frost/signTransaction";
import { withRpcFallback } from "@/services/solanaRpc";
import {
  assertVaultBootstrapSimulation,
  prepareVaultBootstrapTransaction,
} from "@/services/bootstrap/vaultBootstrap";
import logo from "@/assets/xlogo.jpeg";
import { useWalletStore } from "@/store/walletStore";
import type { SignRequestPayload } from "@/services/relay/channelRelay";

type CeremonyPhase =
  | "pairing"       // Show QR / waiting for devices
  | "dkg-round1"    // DKG Part 1: generating commitments
  | "dkg-round2"    // DKG Part 2: exchanging packages
  | "dkg-round3"    // DKG Part 3: computing group key
  | "complete";     // All done, show group pubkey

interface DeviceInfo {
  id: string;
  name: string;
  type: "browser" | "mobile" | "desktop";
  status: "connecting" | "paired" | "ready" | "error";
  joinedAt: number;
}

interface DKGCeremonyProps {
  config: VaultConfig;
  onComplete: (groupPublicKey: string) => void;
  onBack: () => void;
}

type BufferedSigningMessage =
  | { type: "round1"; fromId: number; commitments: number[] }
  | { type: "round2"; fromId: number; share: number[] };

const DEFAULT_BOOTSTRAP_FUNDING_HINT_LAMPORTS = Math.floor(0.01 * LAMPORTS_PER_SOL);

function decodeVaultPublicKey(groupPublicKey: string): PublicKey {
  if (/^[0-9a-fA-F]{64}$/.test(groupPublicKey)) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = parseInt(groupPublicKey.slice(index * 2, index * 2 + 2), 16);
    }
    return new PublicKey(bytes);
  }

  return new PublicKey(groupPublicKey);
}

function formatSolAmount(lamports: number): string {
  if (lamports === 0) return "0 SOL";

  const sol = lamports / LAMPORTS_PER_SOL;
  const decimals = sol >= 1 ? 3 : sol >= 0.01 ? 4 : 6;
  return `${sol.toFixed(decimals)} SOL`;
}

function formatBootstrapFundingError(walletAddress: string, lamports: number): string {
  return `Fund ${walletAddress} with at least ${formatSolAmount(lamports)} before finalizing the on-chain Vaulkyrie bootstrap.`;
}

function describeBootstrapError(error: unknown, walletAddress: string, lamports: number): string {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  if (
    lowerMessage.includes("airdrop limit") ||
    lowerMessage.includes("faucet has run dry")
  ) {
    return `${formatBootstrapFundingError(walletAddress, lamports)} The devnet faucet is unavailable right now, so fund the address manually and refresh the balance.`;
  }
  if (message.includes("Attempt to debit an account but found no record of a prior credit")) {
    return formatBootstrapFundingError(walletAddress, lamports);
  }
  return message;
}

export function DKGCeremony({ config, onComplete, onBack }: DKGCeremonyProps) {
  const relayUrl = useWalletStore((state) => state.relayUrl);
  const network = useWalletStore((state) => state.network);
  const getXmssTree = useWalletStore((state) => state.getXmssTree);
  const storeXmssTree = useWalletStore((state) => state.storeXmssTree);
  const [phase, setPhase] = useState<CeremonyPhase>("pairing");
  const [sessionCode, setSessionCode] = useState(generateSessionCode);
  const [relaySessionInfo, setRelaySessionInfo] = useState(() => createRelaySessionMetadata(sessionCode));
  const [qrPayload, setQrPayload] = useState(() =>
    buildQrPayload(sessionCode, config.threshold, config.totalParticipants),
  );
  const [devices, setDevices] = useState<DeviceInfo[]>([
    {
      id: "self",
      name: "This Browser",
      type: "browser",
      status: "ready",
      joinedAt: Date.now(),
    },
  ]);
  const [dkgProgress, setDkgProgress] = useState(0);
  const [dkgMessage, setDkgMessage] = useState("");
  const [groupPublicKey, setGroupPublicKey] = useState("");
  const [dkgError, setDkgError] = useState<string | null>(null);
  const [bootstrapMessage, setBootstrapMessage] = useState("");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isCheckingBootstrapFunding, setIsCheckingBootstrapFunding] = useState(false);
  const [isFundingVault, setIsFundingVault] = useState(false);
  const [bootstrapWalletAddress, setBootstrapWalletAddress] = useState("");
  const [bootstrapBalanceLamports, setBootstrapBalanceLamports] = useState<number | null>(null);
  const [bootstrapRequiredLamports, setBootstrapRequiredLamports] = useState<number | null>(null);
  const [bootstrapPendingActions, setBootstrapPendingActions] = useState<string[]>([]);
  const [bootstrapAlreadyInitialized, setBootstrapAlreadyInitialized] = useState(false);
  const [copied, setCopied] = useState(false);
  const [relayMode, setRelayMode] = useState<"local" | "remote" | null>(null);
  const [, setConnectionState] = useState<ConnectionState>("disconnected");

  const relayRef = useRef<RelayAdapter | null>(null);
  const orchestratorRef = useRef<DkgOrchestrator | null>(null);
  const signingOrchestratorRef = useRef<SigningOrchestrator | null>(null);
  const pendingSigningMessagesRef = useRef<BufferedSigningMessage[]>([]);
  const dkgStartTimeRef = useRef<number>(0);
  const phaseRef = useRef<CeremonyPhase>("pairing");
  const bootstrappingRef = useRef(false);
  const MIN_ANIMATION_MS = 4000;

  const allDevicesPaired = devices.filter((d) => d.status === "ready").length >= config.totalParticipants;
  const bootstrapFundingReady =
    bootstrapAlreadyInitialized ||
    (
      bootstrapRequiredLamports !== null &&
      bootstrapBalanceLamports !== null &&
      bootstrapBalanceLamports >= bootstrapRequiredLamports
    );

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    bootstrappingRef.current = isBootstrapping;
  }, [isBootstrapping]);

  // Detect relay availability on mount and set up relay
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const available = await probeRelayAvailability(relayUrl);
      if (cancelled) return;

      const mode = available ? "remote" : "local";
      setRelayMode(mode);

      const relay = createRelay({
        mode,
        participantId: 1, // coordinator is always participant 1
        isCoordinator: true,
        deviceName: "This Browser",
        relayUrl,
        sessionId: sessionCode,
        events: {
          onParticipantJoined: (p: RelayParticipant) => {
            setDevices((prev) => {
              if (prev.some((d) => d.id === p.senderId)) return prev;
              return [...prev, {
                id: p.senderId,
                name: p.deviceName,
                type: p.deviceType,
                status: "ready",
                joinedAt: p.joinedAt,
              }];
            });
          },
          onParticipantLeft: (senderId: string) => {
            setDevices((prev) => prev.filter((d) => d.id !== senderId));
          },
          onDkgRound1: (fromId: number, pkg: number[]) => {
            orchestratorRef.current?.handleDkgRound1(fromId, pkg);
          },
          onDkgRound2: (fromId: number, packages: Record<number, number[]>) => {
            orchestratorRef.current?.handleDkgRound2(fromId, packages);
          },
          onDkgRound3Done: (fromId: number, groupKeyHex: string) => {
            orchestratorRef.current?.handleDkgRound3Done(fromId, groupKeyHex);
          },
          onError: (_fromId: number, error: string) => {
            if (bootstrappingRef.current || phaseRef.current === "complete") {
              setBootstrapError(error);
              setIsBootstrapping(false);
              return;
            }
            setDkgError(error);
            setPhase("pairing");
          },
          onSignRequest: () => {},
          onSignRound1: (fromId, commitments) => {
            queueOrHandleSigningMessage({ type: "round1", fromId, commitments });
          },
          onSignRound2: (fromId, share) => {
            queueOrHandleSigningMessage({ type: "round2", fromId, share });
          },
          onSignComplete: () => {},
          onStartDkg: () => {},
          onParticipantIdAssigned: () => {},
        },
        onConnectionStateChange: setConnectionState,
        onSessionCreated: (session) => {
          console.log("[DKGCeremony] Session created:", session.invite);
          setSessionCode(session.code);
          setRelaySessionInfo(session);
          setQrPayload(
            buildQrPayload(
              session.code,
              config.threshold,
              config.totalParticipants,
              session.authToken,
              session.expiresAt,
            ),
          );
        },
      });

      relayRef.current = relay;
      relay.connect();

      if (mode === "remote") {
        relay.createSession(config.threshold, config.totalParticipants, sessionCode);
      }
    })();

    return () => {
      cancelled = true;
      relayRef.current?.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl]);

  const queueOrHandleSigningMessage = useCallback((message: BufferedSigningMessage) => {
    const orchestrator = signingOrchestratorRef.current;
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
    signingOrchestratorRef.current = orchestrator;

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

  // Start DKG — multi-device via orchestrator, or local fallback
  const delayedComplete = useCallback((fn: () => void) => {
    const elapsed = Date.now() - dkgStartTimeRef.current;
    const remaining = Math.max(0, MIN_ANIMATION_MS - elapsed);
    if (remaining > 0) {
      setDkgProgress(95);
      setDkgMessage("Finalizing key shares…");
      setTimeout(fn, remaining);
    } else {
      fn();
    }
  }, []);

  const refreshBootstrapFunding = useCallback(async (targetGroupPublicKey?: string) => {
    const publicKey = targetGroupPublicKey ?? groupPublicKey;
    if (!publicKey) {
      return;
    }

    const walletPubkey = decodeVaultPublicKey(publicKey);
    const walletAddress = walletPubkey.toBase58();
    setBootstrapWalletAddress(walletAddress);
    setBootstrapError(null);
    setIsCheckingBootstrapFunding(true);
    setBootstrapMessage("Checking vault funding and bootstrap readiness...");

    try {
      const result = await withRpcFallback(network, async (connection) => {
        const prepared = await prepareVaultBootstrapTransaction({
          connection,
          walletPubkey,
          existingXmssTree: getXmssTree(walletAddress),
        });
        const balanceLamports = await connection.getBalance(walletPubkey, "confirmed");
        return {
          actions: prepared.actions,
          balanceLamports,
          requiredFundingLamports: prepared.requiredFundingLamports,
          alreadyInitialized: prepared.transaction === null,
        };
      });

      setBootstrapPendingActions(result.actions);
      setBootstrapBalanceLamports(result.balanceLamports);
      setBootstrapRequiredLamports(result.requiredFundingLamports);
      setBootstrapAlreadyInitialized(result.alreadyInitialized);
      setBootstrapMessage(
        result.alreadyInitialized
          ? "Vault bootstrap already exists on-chain."
          : result.balanceLamports >= result.requiredFundingLamports
            ? `Vault is funded and ready to bootstrap ${result.actions.join(", ")}.`
            : `${formatBootstrapFundingError(walletAddress, result.requiredFundingLamports)} Current balance: ${formatSolAmount(result.balanceLamports)}.`,
      );
    } catch (error) {
      setBootstrapError(
        describeBootstrapError(
          error,
          walletAddress,
          bootstrapRequiredLamports ?? DEFAULT_BOOTSTRAP_FUNDING_HINT_LAMPORTS,
        ),
      );
    } finally {
      setIsCheckingBootstrapFunding(false);
    }
  }, [bootstrapRequiredLamports, getXmssTree, groupPublicKey, network]);

  const requestDevnetFunding = useCallback(async () => {
    if (network !== "devnet" || !bootstrapWalletAddress || bootstrapRequiredLamports === null) {
      return;
    }

    const walletPubkey = new PublicKey(bootstrapWalletAddress);
    const currentBalance = bootstrapBalanceLamports ?? 0;
    const neededLamports = Math.max(bootstrapRequiredLamports - currentBalance, 0);
    if (neededLamports === 0) {
      void refreshBootstrapFunding();
      return;
    }

    setBootstrapError(null);
    setIsFundingVault(true);
    setBootstrapMessage(`Requesting ${formatSolAmount(neededLamports)} from the devnet faucet...`);

    try {
      await withRpcFallback(network, async (connection) => {
        const signature = await connection.requestAirdrop(walletPubkey, neededLamports);
        await connection.confirmTransaction(signature, "confirmed");
      });
      await refreshBootstrapFunding();
    } catch (error) {
      setBootstrapError(
        describeBootstrapError(error, bootstrapWalletAddress, neededLamports),
      );
    } finally {
      setIsFundingVault(false);
    }
  }, [
    bootstrapBalanceLamports,
    bootstrapRequiredLamports,
    bootstrapWalletAddress,
    network,
    refreshBootstrapFunding,
  ]);

  useEffect(() => {
    if (phase !== "complete" || !groupPublicKey) {
      return;
    }

    void refreshBootstrapFunding();
  }, [groupPublicKey, phase, refreshBootstrapFunding]);

  const handleFinalizeVault = useCallback(async () => {
    if (!groupPublicKey || isBootstrapping || isCheckingBootstrapFunding || !bootstrapFundingReady) {
      return;
    }

    setBootstrapError(null);
    setIsBootstrapping(true);
    setBootstrapMessage("Preparing Vaulkyrie vault bootstrap...");

    let walletAddress = groupPublicKey;
    let relay: RelayAdapter | null = null;
    let isMultiDevice = false;

    try {
      const dkgRaw = sessionStorage.getItem("vaulkyrie_dkg_result");
      if (!dkgRaw) {
        throw new Error("Missing DKG result. Run the ceremony again.");
      }

      const dkg = JSON.parse(dkgRaw) as {
        groupPublicKeyHex: string;
        publicKeyPackage: string;
        keyPackages: Record<number, string>;
        threshold: number;
        participantId?: number;
        isMultiDevice?: boolean;
      };
      const walletPubkey = decodeVaultPublicKey(dkg.groupPublicKeyHex);
      walletAddress = walletPubkey.toBase58();
      const myParticipantId = dkg.participantId ?? 1;
      const myKeyPackage = dkg.keyPackages?.[myParticipantId];
      const availableKeyIds = Object.keys(dkg.keyPackages ?? {}).map(Number);
      relay = relayRef.current;
      isMultiDevice = dkg.isMultiDevice === true;

      const result = await withRpcFallback(network, async (connection) => {
        const prepared = await prepareVaultBootstrapTransaction({
          connection,
          walletPubkey,
          existingXmssTree: getXmssTree(walletAddress),
        });

        if (!prepared.transaction) {
          if (relay && isMultiDevice) {
            relay.broadcastSignComplete("already-initialized", true);
          }
          return { signature: null, generatedXmssTree: prepared.generatedXmssTree };
        }

        const currentBalance = await connection.getBalance(walletPubkey, "confirmed");
        if (currentBalance < prepared.requiredFundingLamports) {
          throw new Error(
            formatBootstrapFundingError(walletAddress, prepared.requiredFundingLamports),
          );
        }

        prepared.transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        setBootstrapMessage("Simulating on-chain bootstrap...");
        await assertVaultBootstrapSimulation(connection, prepared.transaction);
        setBootstrapMessage(`Bootstrapping ${prepared.actions.join(", ")}...`);

        if (
          isMultiDevice ||
          availableKeyIds.length < dkg.threshold
        ) {
          if (!relay) {
            throw new Error("Relay session is no longer available for multi-device bootstrap.");
          }
          if (!myKeyPackage) {
            throw new Error(`No key package found for participant ${myParticipantId}.`);
          }

          const signerIds = [myParticipantId, ...relay
            .getParticipants()
            .map((participant) => participant.participantId)
            .filter((participantId, index, ids) => participantId > 0 && ids.indexOf(participantId) === index)
            .sort((left, right) => left - right)]
            .filter((participantId, index, ids) => ids.indexOf(participantId) === index)
            .slice(0, dkg.threshold);

          if (signerIds.length < dkg.threshold) {
            throw new Error(
              `Need ${dkg.threshold} connected signers to finalize bootstrap, but only ${signerIds.length} are available.`,
            );
          }

          const request: SignRequestPayload = {
            requestId: crypto.randomUUID(),
            message: Array.from(prepared.transaction.serializeMessage()),
            signerIds,
            amount: 0,
            token: "VAULKYRIE",
            recipient: walletAddress,
            initiator: config.vaultName,
            network,
            createdAt: Date.now(),
            purpose: "bootstrap",
            summary: `Finalize ${prepared.actions.join(", ")}`,
          };
          relay.broadcastSignRequest(request);

          const signingResult = await runSigningOrchestrator({
            relay,
            participantId: myParticipantId,
            keyPackageJson: myKeyPackage,
            publicKeyPackageJson: dkg.publicKeyPackage,
            message: prepared.transaction.serializeMessage(),
            signerIds,
            onStatus: setBootstrapMessage,
          });

          if (!signingResult.verified) {
            throw new Error("Bootstrap signature verification failed.");
          }

          prepared.transaction.addSignature(walletPubkey, Buffer.from(hexToBytes(signingResult.signatureHex)));
          const signature = await connection.sendRawTransaction(prepared.transaction.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
          await connection.confirmTransaction(signature, "confirmed");
          relay.broadcastSignComplete(signature, true);
          return { signature, generatedXmssTree: prepared.generatedXmssTree };
        }

        const signature = await signAndSendTransaction(
          connection,
          prepared.transaction,
          walletAddress,
          setBootstrapMessage,
        );
        await connection.confirmTransaction(signature, "confirmed");
        return { signature, generatedXmssTree: prepared.generatedXmssTree };
      });

      if (result.generatedXmssTree) {
        storeXmssTree(walletAddress, result.generatedXmssTree);
      }

      setBootstrapMessage(
        result.signature
          ? `Vault bootstrap confirmed: ${result.signature}`
          : "Vault bootstrap already existed on-chain.",
      );
      setBootstrapAlreadyInitialized(true);
      onComplete(groupPublicKey);
    } catch (error) {
      const message = describeBootstrapError(
        error,
        walletAddress,
        bootstrapRequiredLamports ?? DEFAULT_BOOTSTRAP_FUNDING_HINT_LAMPORTS,
      );
      if (relay && isMultiDevice) {
        relay.broadcastError(message);
      }
      setBootstrapError(message);
      setIsBootstrapping(false);
      return;
    }

    setIsBootstrapping(false);
  }, [
    config.vaultName,
    getXmssTree,
    groupPublicKey,
    isCheckingBootstrapFunding,
    isBootstrapping,
    network,
    onComplete,
    runSigningOrchestrator,
    storeXmssTree,
    bootstrapFundingReady,
    bootstrapRequiredLamports,
  ]);

  const startDKG = useCallback(() => {
    setPhase("dkg-round1");
    setDkgProgress(0);
    setDkgError(null);
    setBootstrapError(null);
    setBootstrapMessage("");
    setBootstrapWalletAddress("");
    setBootstrapBalanceLamports(null);
    setBootstrapRequiredLamports(null);
    setBootstrapPendingActions([]);
    setBootstrapAlreadyInitialized(false);
    dkgStartTimeRef.current = Date.now();

    const relay = relayRef.current;
    const useOrchestrator = relay && devices.length > 1;

    if (useOrchestrator) {
      // Multi-device DKG via relay + orchestrator
      const handleProgress = (p: DkgOrchestratorProgress) => {
        setDkgProgress(Math.round(p.progress));
        setDkgMessage(p.message);
        if (p.phase === "round1") setPhase("dkg-round1");
        else if (p.phase === "round2") setPhase("dkg-round2");
        else if (p.phase === "round3" || p.phase === "validating") setPhase("dkg-round3");
      };

      const orchestrator = new DkgOrchestrator({
        relay,
        participantId: 1,
        threshold: config.threshold,
        totalParticipants: config.totalParticipants,
        onProgress: handleProgress,
      });
      orchestratorRef.current = orchestrator;

      orchestrator.run()
        .then((result) => {
          delayedComplete(() => {
            setGroupPublicKey(result.groupPublicKeyHex);
            setDkgProgress(100);
            setPhase("complete");

            try {
              sessionStorage.setItem(
                "vaulkyrie_dkg_result",
                JSON.stringify({
                  groupPublicKeyHex: result.groupPublicKeyHex,
                  publicKeyPackage: result.publicKeyPackageJson,
                  keyPackages: { [result.participantId]: result.keyPackageJson },
                  threshold: result.threshold,
                  participants: result.totalParticipants,
                  participantId: result.participantId,
                  isMultiDevice: true,
                  createdAt: Date.now(),
                }),
              );
            } catch { /* sessionStorage may be unavailable */ }
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setDkgError(message);
          setPhase("pairing");
        });
    } else {
      // Local single-browser DKG (demo/fallback)
      const handleProgress = (p: LocalDkgProgress) => {
        setDkgProgress(p.progress);
        setDkgMessage(p.message);
        if (p.phase === "round1") setPhase("dkg-round1");
        else if (p.phase === "round2") setPhase("dkg-round2");
        else if (p.phase === "round3") setPhase("dkg-round3");
      };

      runLocalDkg(config.threshold, config.totalParticipants, handleProgress)
        .then((result) => {
          delayedComplete(() => {
            setGroupPublicKey(result.groupPublicKeyHex);
            setDkgProgress(100);
            setPhase("complete");

            try {
              sessionStorage.setItem(
                "vaulkyrie_dkg_result",
                JSON.stringify({
                  groupPublicKeyHex: result.groupPublicKeyHex,
                  publicKeyPackage: result.publicKeyPackage,
                  keyPackages: result.keyPackages,
                  threshold: config.threshold,
                  participants: config.totalParticipants,
                  createdAt: Date.now(),
                }),
              );
            } catch { /* sessionStorage may be unavailable */ }
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setDkgError(message);
          setPhase("pairing");
        });
    }
  }, [config.threshold, config.totalParticipants, devices.length, delayedComplete]);

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(
      relayMode === "remote" ? relaySessionInfo.invite : sessionCode,
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const DeviceIcon = ({ type }: { type: DeviceInfo["type"] }) => {
    switch (type) {
      case "mobile":
        return <Smartphone className="h-4 w-4" />;
      case "desktop":
        return <Monitor className="h-4 w-4" />;
      default:
        return <QrCode className="h-4 w-4" />;
    }
  };

  const StatusBadge = ({ status }: { status: DeviceInfo["status"] }) => {
    switch (status) {
      case "connecting":
        return (
          <span className="flex items-center gap-1 text-[10px] text-warning">
            <Loader2 className="h-3 w-3 animate-spin" />
            Connecting
          </span>
        );
      case "paired":
        return (
          <span className="flex items-center gap-1 text-[10px] text-info">
            <Wifi className="h-3 w-3" />
            Paired
          </span>
        );
      case "ready":
        return (
          <span className="flex items-center gap-1 text-[10px] text-success">
            <Check className="h-3 w-3" />
            Ready
          </span>
        );
      case "error":
        return (
          <span className="flex items-center gap-1 text-[10px] text-destructive">
            <WifiOff className="h-3 w-3" />
            Error
          </span>
        );
    }
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        {phase === "pairing" && (
          <button
            onClick={onBack}
            className="p-1.5 rounded-lg hover:bg-card transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
        <div className="flex-1">
          <h2 className="text-base font-semibold">
            {phase === "pairing" && "Pair Devices"}
            {phase.startsWith("dkg") && "Key Generation"}
            {phase === "complete" && "Vault Created"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {phase === "pairing" &&
              `Step 2 of 3 · ${devices.filter((d) => d.status === "ready").length}/${config.totalParticipants} devices`}
            {phase === "dkg-round1" && "Round 1 · Generating commitments..."}
            {phase === "dkg-round2" && "Round 2 · Exchanging packages..."}
            {phase === "dkg-round3" && "Round 3 · Computing group key..."}
            {phase === "complete" && "Step 3 of 3 · Fund and finalize your vault"}
          </p>
        </div>
        <img src={logo} alt="" className="h-7 w-7 rounded-lg opacity-60" />
      </div>

      <div className="flex flex-col flex-1 px-5 py-4 overflow-y-auto">
        <AnimatePresence mode="wait">
          {/* ── PAIRING PHASE ── */}
          {phase === "pairing" && (
            <motion.div
              key="pairing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col flex-1"
            >
              {/* QR Code area */}
              <div className="bg-card border border-border rounded-xl p-4 mb-4">
                <div className="text-center mb-3">
                  <p className="text-xs text-muted-foreground mb-1">
                    Scan with another Vaulkyrie device
                  </p>
                </div>

                {/* Real QR code with teal glow */}
                <div className="relative mx-auto w-44 h-44 mb-3">
                  <div className="absolute -inset-2 bg-primary/10 rounded-2xl blur-lg" />
                  <div className="relative bg-white rounded-xl p-3 w-full h-full flex items-center justify-center">
                    <QRCodeSVG
                      value={qrPayload}
                      size={152}
                      level="M"
                      bgColor="#ffffff"
                      fgColor="#0f172a"
                      imageSettings={{
                        src: logo,
                        height: 24,
                        width: 24,
                        excavate: true,
                      }}
                    />
                  </div>
                </div>

                {/* Relay mode indicator */}
                <div className="flex items-center justify-center gap-1.5 mb-2">
                  <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    relayMode === "remote"
                      ? "bg-success/15 text-success"
                      : relayMode === "local"
                        ? "bg-warning/15 text-warning"
                        : "bg-muted text-muted-foreground"
                  }`}>
                    {relayMode === "remote" ? <Wifi className="h-2.5 w-2.5" /> : relayMode === "local" ? <WifiOff className="h-2.5 w-2.5" /> : <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                    {relayMode === "remote" ? "Cross-device relay" : relayMode === "local" ? "Same-browser only" : "Detecting…"}
                  </span>
                </div>

                {/* Session invite for manual entry */}
                <div className="flex items-center justify-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {relayMode === "remote" ? "Share invite:" : "Or enter code:"}
                  </span>
                  <button
                    onClick={handleCopyCode}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted font-mono cursor-pointer hover:bg-accent transition-colors ${
                      relayMode === "remote" ? "text-[11px] font-semibold tracking-wide" : "text-sm font-bold tracking-widest"
                    }`}
                  >
                    {relayMode === "remote" ? relaySessionInfo.invite : sessionCode}
                    {copied ? (
                      <Check className="h-3 w-3 text-success" />
                    ) : (
                      <Copy className="h-3 w-3 text-muted-foreground" />
                    )}
                  </button>
                </div>
                {relayMode === "remote" && (
                  <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-center">
                    <div className="flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-wide text-primary">
                      <Shield className="h-3 w-3" />
                      Verify this phrase on every device
                    </div>
                    <div className="mt-1 font-mono text-sm font-semibold text-foreground">
                      {relaySessionInfo.verificationPhrase}
                    </div>
                  </div>
                )}
              </div>

              {/* Device list */}
              <div className="mb-4">
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Connected Devices
                </p>
                <div className="flex flex-col gap-2">
                  <AnimatePresence>
                    {devices.map((device) => (
                      <motion.div
                        key={device.id}
                        initial={{ opacity: 0, y: 10, height: 0 }}
                        animate={{ opacity: 1, y: 0, height: "auto" }}
                        className="flex items-center gap-3 p-3 rounded-lg bg-card border border-border"
                      >
                        <div
                          className={`h-8 w-8 rounded-lg flex items-center justify-center ${
                            device.status === "ready"
                              ? "bg-success/15 text-success"
                              : device.status === "connecting"
                                ? "bg-warning/15 text-warning"
                                : "bg-info/15 text-info"
                          }`}
                        >
                          <DeviceIcon type={device.type} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {device.name}
                          </p>
                          <StatusBadge status={device.status} />
                        </div>
                        {device.id === "self" && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium">
                            YOU
                          </span>
                        )}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>

              {/* Waiting indicator */}
              {!allDevicesPaired && !dkgError && (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground mb-4">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  Waiting for{" "}
                  {config.totalParticipants -
                    devices.filter((d) => d.status === "ready").length}{" "}
                  more device
                  {config.totalParticipants -
                    devices.filter((d) => d.status === "ready").length >
                  1
                    ? "s"
                    : ""}
                  ...
                </div>
              )}

              {/* DKG Error display */}
              {dkgError && (
                <motion.div
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 mb-4"
                >
                  <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-destructive">DKG Failed</p>
                    <p className="text-[10px] text-destructive/80 mt-0.5">{dkgError}</p>
                    <button
                      onClick={() => { setDkgError(null); startDKG(); }}
                      className="text-[10px] text-primary hover:underline mt-1 cursor-pointer"
                    >
                      Try again
                    </button>
                  </div>
                </motion.div>
              )}
            </motion.div>
          )}

          {/* ── DKG CEREMONY PHASE ── */}
          {phase.startsWith("dkg") && (
            <motion.div
              key="dkg"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col flex-1 items-center justify-center"
            >
              {/* Animated ceremony visualization */}
              <div className="relative mb-8">
                {/* Outer ring */}
                <motion.div
                  className="w-40 h-40 rounded-full border-2 border-primary/30"
                  animate={{ rotate: 360 }}
                  transition={{
                    duration: 8,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                >
                  {/* Orbiting particles */}
                  {devices.map((_, i) => (
                    <motion.div
                      key={i}
                      className="absolute w-3 h-3 rounded-full bg-primary shadow-lg shadow-primary/50"
                      style={{
                        top: "50%",
                        left: "50%",
                        transformOrigin: "0 0",
                      }}
                      animate={{
                        rotate: [
                          i * (360 / devices.length),
                          i * (360 / devices.length) + 360,
                        ],
                        x: [70, 70],
                        y: [-6, -6],
                      }}
                      transition={{
                        duration: 4,
                        repeat: Infinity,
                        ease: "linear",
                        delay: i * 0.3,
                      }}
                    />
                  ))}
                </motion.div>

                {/* Center logo */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <motion.div
                    animate={{
                      boxShadow: [
                        "0 0 20px rgba(78, 205, 196, 0.2)",
                        "0 0 40px rgba(78, 205, 196, 0.4)",
                        "0 0 20px rgba(78, 205, 196, 0.2)",
                      ],
                    }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="rounded-2xl"
                  >
                    <img
                      src={logo}
                      alt=""
                      className="h-14 w-14 rounded-2xl"
                    />
                  </motion.div>
                </div>
              </div>

              {/* Progress bar */}
              <div className="w-full max-w-[260px] mb-4">
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-primary/80 to-primary"
                    initial={{ width: "0%" }}
                    animate={{ width: `${dkgProgress}%` }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                  />
                </div>
                <div className="flex justify-between mt-1.5">
                  <span className="text-[10px] text-muted-foreground">
                    {dkgMessage || (
                      <>
                        {phase === "dkg-round1" && "Generating commitments"}
                        {phase === "dkg-round2" && "Exchanging packages"}
                        {phase === "dkg-round3" && "Computing group key"}
                      </>
                    )}
                  </span>
                  <span className="text-[10px] font-mono text-primary">
                    {dkgProgress}%
                  </span>
                </div>
              </div>

              {/* Round indicators */}
              <div className="flex gap-8">
                {["Round 1", "Round 2", "Round 3"].map((label, i) => {
                  const roundNum = i + 1;
                  const currentRound =
                    phase === "dkg-round1" ? 1 :
                    phase === "dkg-round2" ? 2 : 3;
                  const isDone = roundNum < currentRound;
                  const isActive = roundNum === currentRound;

                  return (
                    <div key={i} className="flex flex-col items-center gap-1">
                      <div
                        className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold ${
                          isDone
                            ? "bg-success/20 text-success"
                            : isActive
                              ? "bg-primary/20 text-primary"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {isDone ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          roundNum
                        )}
                      </div>
                      <span
                        className={`text-[10px] ${
                          isActive ? "text-primary font-medium" : "text-muted-foreground"
                        }`}
                      >
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>

              <p className="text-xs text-muted-foreground text-center mt-6 px-8 leading-relaxed">
                Real FROST dealerless DKG running via WASM.
                No single device ever holds the full private key.
              </p>
            </motion.div>
          )}

          {/* ── COMPLETE PHASE ── */}
          {phase === "complete" && (
            <motion.div
              key="complete"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col flex-1 items-center justify-center"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{
                  type: "spring",
                  stiffness: 200,
                  damping: 15,
                  delay: 0.2,
                }}
                className="relative mb-6"
              >
                <div className="absolute -inset-4 bg-success/20 rounded-full blur-xl" />
                <div className="relative h-20 w-20 rounded-full bg-success/15 border-2 border-success/40 flex items-center justify-center">
                  <Shield className="h-10 w-10 text-success" />
                </div>
              </motion.div>

              <h3 className="text-xl font-bold mb-1">Vault Created!</h3>
              <p className="text-sm text-muted-foreground mb-6 text-center">
                {config.threshold}-of-{config.totalParticipants} threshold
                signing is active
              </p>

              {/* Group public key */}
              <div className="w-full bg-card border border-border rounded-xl p-4 mb-4">
                <p className="text-xs text-muted-foreground mb-2">
                  Group Public Key
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono text-foreground bg-muted rounded-md px-2.5 py-2 truncate">
                    {groupPublicKey}
                  </code>
                  <button
                    onClick={async () => {
                      await navigator.clipboard.writeText(groupPublicKey);
                    }}
                    className="p-2 rounded-lg hover:bg-accent transition-colors cursor-pointer shrink-0"
                  >
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
              </div>

              <div className="w-full bg-card border border-border rounded-xl p-4 mb-4">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <p className="text-xs text-muted-foreground">
                    Vault address
                  </p>
                  {(isCheckingBootstrapFunding || isFundingVault) && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-primary">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {isFundingVault ? "Funding" : "Checking"}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono text-foreground bg-muted rounded-md px-2.5 py-2 truncate">
                    {bootstrapWalletAddress || "Deriving vault address..."}
                  </code>
                  <button
                    onClick={async () => {
                      if (!bootstrapWalletAddress) return;
                      await navigator.clipboard.writeText(bootstrapWalletAddress);
                    }}
                    disabled={!bootstrapWalletAddress}
                    className="p-2 rounded-lg hover:bg-accent transition-colors cursor-pointer shrink-0 disabled:opacity-40"
                  >
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div className="rounded-lg bg-muted/60 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Current balance</p>
                    <p className="text-sm font-medium text-foreground mt-1">
                      {bootstrapBalanceLamports === null ? "—" : formatSolAmount(bootstrapBalanceLamports)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/60 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {bootstrapAlreadyInitialized ? "Bootstrap state" : "Required to bootstrap"}
                    </p>
                    <p className="text-sm font-medium text-foreground mt-1">
                      {bootstrapAlreadyInitialized
                        ? "Already initialized"
                        : bootstrapRequiredLamports === null
                          ? "—"
                          : formatSolAmount(bootstrapRequiredLamports)}
                    </p>
                  </div>
                </div>
                {!bootstrapAlreadyInitialized && bootstrapPendingActions.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-3">
                    Bootstrap will create: {bootstrapPendingActions.join(", ")}.
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                  The derived Vaulkyrie vault address pays the rent and network fees for its registry, authority, and policy PDAs.
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => { void refreshBootstrapFunding(); }}
                    disabled={isCheckingBootstrapFunding || isFundingVault || !bootstrapWalletAddress}
                    className="flex-1 py-2.5 rounded-lg border border-border bg-background text-sm font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                  >
                    Refresh balance
                  </button>
                  {network === "devnet" && !bootstrapAlreadyInitialized && (
                    <button
                      onClick={() => { void requestDevnetFunding(); }}
                      disabled={
                        isCheckingBootstrapFunding ||
                        isFundingVault ||
                        !bootstrapWalletAddress ||
                        bootstrapFundingReady
                      }
                      className="flex-1 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {isFundingVault ? "Requesting faucet..." : "Request devnet faucet"}
                    </button>
                  )}
                </div>
              </div>

              {/* Devices summary */}
              <div className="w-full bg-card border border-border rounded-xl p-4 mb-4">
                <p className="text-xs text-muted-foreground mb-2">
                  Participating Devices
                </p>
                {devices
                  .filter((d) => d.status === "ready")
                  .map((device) => (
                    <div
                      key={device.id}
                      className="flex items-center gap-2 py-1.5"
                    >
                      <DeviceIcon type={device.type} />
                      <span className="text-sm flex-1">{device.name}</span>
                      <Check className="h-3.5 w-3.5 text-success" />
                    </div>
                  ))}
              </div>

              <div className="w-full bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground mb-2">
                  On-chain bootstrap
                </p>
                <p className="text-sm text-foreground">
                  {bootstrapMessage || "Fund the derived vault address, then finalize the on-chain vault, authority, and policy PDAs before opening the wallet."}
                </p>
                {bootstrapError && (
                  <p className="text-xs text-destructive mt-2">
                    {bootstrapError}
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom action */}
      <div className="px-5 pb-5">
        {phase === "pairing" && (
          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            onClick={startDKG}
            disabled={!allDevicesPaired}
            className="w-full py-3.5 rounded-xl font-semibold text-sm cursor-pointer
                       bg-primary text-primary-foreground
                       disabled:opacity-40 disabled:cursor-not-allowed
                       shadow-lg shadow-primary/20 hover:shadow-primary/35 transition-all
                       flex items-center justify-center gap-2"
          >
            <Shield className="h-4 w-4" />
            Start Key Generation
          </motion.button>
        )}

        {phase === "complete" && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleFinalizeVault}
            disabled={isBootstrapping || isCheckingBootstrapFunding || !bootstrapFundingReady}
            className="w-full py-3.5 rounded-xl font-semibold text-sm cursor-pointer
                       bg-primary text-primary-foreground
                       disabled:opacity-60 disabled:cursor-not-allowed
                       shadow-lg shadow-primary/20 hover:shadow-primary/35 transition-all
                       flex items-center justify-center gap-2"
          >
            {isBootstrapping
              ? "Finalizing Vault..."
              : isCheckingBootstrapFunding
                ? "Checking Vault Funding..."
                : bootstrapAlreadyInitialized
                  ? "Open Wallet"
                  : bootstrapFundingReady
                    ? "Finalize & Open Vault"
                    : "Fund Vault Before Finalizing"}
            {isBootstrapping || isCheckingBootstrapFunding
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Shield className="h-4 w-4" />}
          </motion.button>
        )}
      </div>
    </div>
  );
}
