import { useState, useRef, useEffect, useCallback } from "react";
import { ArrowUpRight, AlertCircle, Loader2, Check, ExternalLink, Users, ChevronDown, Radio } from "lucide-react";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { signLocal, hexToBytes } from "@/services/frost/frostService";
import { SigningOrchestrator } from "@/services/frost/signingOrchestrator";
import { createRelay, DEFAULT_RELAY_URL, generateSessionCode, type RelayAdapter } from "@/services/relay/relayAdapter";
import type { SignRequestPayload } from "@/services/relay/channelRelay";
import { useWalletStore } from "@/store/walletStore";
import { createConnection, SOL_ICON } from "@/services/solanaRpc";
import { buildSplTransferTransaction } from "@/services/splToken";
import { shortenAddress } from "@/lib/utils";
import type { WalletView, Token } from "@/types";

interface SendViewProps {
  balance: number;
  onNavigate: (view: WalletView) => void;
}

type SendPhase = "form" | "review" | "join-review" | "signing" | "coordinate" | "success" | "error";
type SendMode = "send" | "join";

type BufferedSigningMessage =
  | { type: "round1"; fromId: number; commitments: number[] }
  | { type: "round2"; fromId: number; share: number[] };

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

async function canReachRelay(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const ws = new WebSocket(url);
      const timeout = window.setTimeout(() => {
        ws.close();
        settle(false);
      }, 1500);

      ws.onopen = () => {
        window.clearTimeout(timeout);
        ws.close();
        settle(true);
      };

      ws.onerror = () => {
        window.clearTimeout(timeout);
        settle(false);
      };
    } catch {
      settle(false);
    }
  });
}

export function SendView({ balance, onNavigate }: SendViewProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<SendPhase>("form");
  const [mode, setMode] = useState<SendMode>("send");
  const [signingMessage, setSigningMessage] = useState("");
  const [txSignature, setTxSignature] = useState("");
  const [signingSessionCode, setSigningSessionCode] = useState("");
  const [joinSessionCode, setJoinSessionCode] = useState("");
  const [pendingSignRequest, setPendingSignRequest] = useState<SignRequestPayload | null>(null);
  const [selectedToken, setSelectedToken] = useState("SOL");
  const [showContacts, setShowContacts] = useState(false);
  const { activeAccount, network, tokens, contacts } = useWalletStore();
  const relayRef = useRef<RelayAdapter | null>(null);
  const orchestratorRef = useRef<SigningOrchestrator | null>(null);
  const pendingSigningMessagesRef = useRef<BufferedSigningMessage[]>([]);
  const signingTimeoutRef = useRef<number | null>(null);

  const selectedTokenInfo = selectedToken === "SOL"
    ? { symbol: "SOL", balance: balance, decimals: 9, mint: undefined }
    : tokens.find((t) => t.symbol === selectedToken) ?? { symbol: selectedToken, balance: 0, decimals: 9, mint: undefined };
  const tokenBalance = selectedTokenInfo.balance;
  const parsedAmount = parseFloat(amount) || 0;
  const isValid =
    recipient.length >= 32 && parsedAmount > 0 && parsedAmount <= tokenBalance;

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
    setPhase("review");
  };

  const handleSign = async () => {
    setPhase("signing");
    setSigningMessage("Loading DKG key packages...");
    setError("");
    setPendingSignRequest(null);

    try {
      const dkg = loadDkgState();
      if (!dkg) {
        throw new Error("No DKG key packages found. Run DKG ceremony first.");
      }

      // Build the Solana transfer transaction
      setSigningMessage("Building transaction...");
      const connection = createConnection(network);
      const fromPubkey = new PublicKey(activeAccount!.publicKey);
      const toPubkey = new PublicKey(recipient);

      let tx: Transaction;

      if (selectedToken === "SOL") {
        tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey,
            toPubkey,
            lamports: Math.floor(parsedAmount * LAMPORTS_PER_SOL),
          }),
        );
      } else {
        const tokenInfo = tokens.find((t) => t.symbol === selectedToken);
        if (!tokenInfo?.mint) throw new Error("Token mint not found");
        tx = await buildSplTransferTransaction(
          connection,
          fromPubkey,
          toPubkey,
          new PublicKey(tokenInfo.mint),
          parsedAmount,
          tokenInfo.decimals ?? 9,
        );
      }

      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = fromPubkey;

      const messageBytes = tx.serializeMessage();

      // Determine available key packages
      const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
      const hasAllKeys = availableKeyIds.length >= dkg.threshold;
      const isMultiDevice = dkg.isMultiDevice === true;

      let signatureHex: string;
      let verified: boolean;

      if (hasAllKeys && !isMultiDevice) {
        // Single-device (local DKG): sign locally with all key packages
        setSigningMessage(`Running FROST threshold signing (${dkg.threshold}-of-${dkg.participants})...`);
        const signerIds = availableKeyIds.slice(0, dkg.threshold);
        const result = await signLocal(messageBytes, dkg.keyPackages, dkg.publicKeyPackage, signerIds);
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
          messageBytes,
          dkg.threshold,
          (msg) => setSigningMessage(msg),
        );
        signatureHex = result.signatureHex;
        verified = result.verified;
      }

      if (!verified) {
        throw new Error("FROST signature verification failed");
      }

      setPhase("signing");
      setSigningMessage("Signature verified! Submitting to Solana...");

      const sigBytes = hexToBytes(signatureHex);
      tx.addSignature(fromPubkey, Buffer.from(sigBytes));

      const rawTx = tx.serialize();
      const signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      cleanupRelayState();
      setTxSignature(signature);
      setPhase("success");
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
    message: Uint8Array,
    requiredSigners: number,
    onStatus: (msg: string) => void,
  ) => {
    cleanupRelayState();
    const relayMode = await canReachRelay(DEFAULT_RELAY_URL) ? "remote" : "local";
    const requestedSessionCode = generateSessionCode();

    setSigningSessionCode(requestedSessionCode);
    return new Promise<{ signatureHex: string; publicKeyHex: string; verified: boolean }>((resolve, reject) => {
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
        relayUrl: DEFAULT_RELAY_URL,
        sessionId: requestedSessionCode,
        events: {
          onParticipantJoined: () => {
            const connectedIds = relay
              .getParticipants()
              .map((candidate) => candidate.participantId)
              .filter((candidateId, index, ids) => candidateId > 0 && ids.indexOf(candidateId) === index);
            onStatus(`Connected signers: ${connectedIds.length}/${requiredSigners}`);

            if (signingStarted || connectedIds.length < requiredSigners) {
              return;
            }

            const signerIds = [participantId, ...connectedIds
              .filter((candidateId) => candidateId !== participantId)
              .sort((left, right) => left - right)]
              .slice(0, requiredSigners);

            if (signerIds.length < requiredSigners) {
              return;
            }

            signingStarted = true;
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
            };

            relay.broadcastSignRequest(request);
            setPhase("signing");

            runSigningOrchestrator({
              relay,
              participantId,
              keyPackageJson,
              publicKeyPackageJson,
              message,
              signerIds,
              onStatus,
            })
              .then((result) => settle(() => resolve(result)))
              .catch((err) => settle(() => reject(err)));
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
            onStatus("Connected to relay. Waiting for the other signer...");
            relay.createSession(requiredSigners, requiredSigners, requestedSessionCode);
          } else if (state === "failed") {
            settle(() => reject(new Error("Relay connection failed")));
          }
        },
        onSessionCreated: (code) => {
          onStatus(`Signing session created: ${code}. Share with other signers.`);
          setSigningSessionCode(code);
        },
      });

      relayRef.current = relay;
      relay.connect();

      if (relayMode === "local") {
        onStatus(`Signing session ${requestedSessionCode} ready. Ask another signer to join from Send > Join Signing Session.`);
      }

      signingTimeoutRef.current = window.setTimeout(() => {
        settle(() => reject(new Error("Signing timed out. Not enough signers connected within 2 minutes.")));
      }, 120_000);
    });
  }, [
    activeAccount?.name,
    cleanupRelayState,
    network,
    parsedAmount,
    queueOrHandleSigningMessage,
    recipient,
    runSigningOrchestrator,
    selectedToken,
  ]);

  const handleJoinSigningSession = useCallback(async () => {
    const sessionCode = joinSessionCode.trim().toUpperCase();
    if (!sessionCode) {
      setError("Enter the signing session code first.");
      return;
    }

    setError("");
    setPhase("coordinate");
    setSigningMessage("Loading local signer key package...");
    cleanupRelayState(false);

    try {
      const dkg = loadDkgState();
      if (!dkg) {
        throw new Error("No DKG key packages found. Run DKG ceremony first.");
      }

      const availableKeyIds = Object.keys(dkg.keyPackages).map(Number);
      const myParticipantId = dkg.participantId ?? availableKeyIds[0] ?? 1;
      const relayMode = await canReachRelay(DEFAULT_RELAY_URL) ? "remote" : "local";
      const relay = createRelay({
        mode: relayMode,
        participantId: myParticipantId,
        isCoordinator: false,
        deviceName: `Signer ${myParticipantId}`,
        relayUrl: DEFAULT_RELAY_URL,
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
            setSigningMessage(`Review the ${request.token} transfer request before signing.`);
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
            if (relayMode === "remote") {
              relay.joinSession(sessionCode);
            }
          } else if (state === "failed") {
            cleanupRelayState();
            setError("Relay connection failed");
            setPhase("error");
          }
        },
      });

      relayRef.current = relay;
      setSigningSessionCode(sessionCode);
      relay.connect();

      if (relayMode === "local") {
        setSigningMessage("Waiting for the coordinator to share a signing request...");
      }
    } catch (err) {
      cleanupRelayState();
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [cleanupRelayState, joinSessionCode, loadDkgState, queueOrHandleSigningMessage]);

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

  const explorerUrl = txSignature
    ? `https://explorer.solana.com/tx/${txSignature}?cluster=${network}`
    : "";
  const successAmount = pendingSignRequest?.amount ?? parsedAmount;
  const successToken = pendingSignRequest?.token ?? selectedToken;
  const successRecipient = pendingSignRequest?.recipient ?? recipient;

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
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Session Code</p>
            <code className="text-lg font-mono font-bold text-primary tracking-[.3em] bg-primary/10 px-4 py-1.5 rounded-lg select-all">
              {signingSessionCode}
            </code>
            <p className="text-[10px] text-muted-foreground mt-1">
              Share this code with other vault signers
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
          {isJoinSuccess
            ? `You approved ${successAmount} ${successToken} to ${shortenAddress(successRecipient, 6)}.`
            : `${successAmount} ${successToken} sent to ${successRecipient.substring(0, 8)}...`}
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
          </CardContent>
        </Card>

        <p className="text-[10px] text-muted-foreground text-center">
          Approve only if you trust the recipient and amount on this device.
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
              <span className="text-xs text-muted-foreground">~0.000005 SOL</span>
            </div>
            <div className="border-t border-border pt-2 flex justify-between">
              <span className="text-xs font-medium">Total</span>
              <span className="text-sm font-bold">
                {selectedToken === "SOL"
                  ? `${(parsedAmount + 0.000005).toFixed(6)} SOL`
                  : `${parsedAmount} ${selectedToken} + ~0.000005 SOL`}
              </span>
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
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Signing session code</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Enter 6-character code"
              value={joinSessionCode}
              onChange={(e) => {
                setJoinSessionCode(e.target.value.toUpperCase());
                setError("");
              }}
              className="font-mono text-center tracking-[0.3em]"
              maxLength={6}
            />
            <p className="text-[11px] text-muted-foreground">
              Use this on another browser or device to approve the coordinator&apos;s transfer.
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
