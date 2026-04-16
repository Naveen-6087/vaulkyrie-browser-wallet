import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Users, Loader2, Check, AlertTriangle, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  createRelay,
  DEFAULT_RELAY_URL,
  type RelayAdapter,
  type ConnectionState,
} from "@/services/relay/relayAdapter";
import {
  DkgOrchestrator,
  type DkgOrchestratorProgress,
} from "@/services/frost/dkgOrchestrator";
import logo from "@/assets/xlogo.jpeg";

interface JoinCeremonyProps {
  onComplete: (groupPublicKey?: string) => void;
  onBack: () => void;
}

type JoinPhase = "enter-code" | "connecting" | "waiting" | "running" | "complete" | "error";

/** Detect if relay server is reachable */
async function isRelayAvailable(url: string): Promise<boolean> {
  try {
    const ws = new WebSocket(url);
    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => { ws.close(); resolve(false); }, 2000);
      ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve(true); };
      ws.onerror = () => { clearTimeout(timeout); resolve(false); };
    });
  } catch { return false; }
}

export function JoinCeremony({ onComplete, onBack }: JoinCeremonyProps) {
  const [sessionCode, setSessionCode] = useState("");
  const [phase, setPhase] = useState<JoinPhase>("enter-code");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [relayMode, setRelayMode] = useState<"local" | "remote" | null>(null);
  const [dkgParams, setDkgParams] = useState<{ threshold: number; participants: number } | null>(null);
  const [participantId, setParticipantId] = useState<number>(0);

  const relayRef = useRef<RelayAdapter | null>(null);
  const orchestratorRef = useRef<DkgOrchestrator | null>(null);

  const isValidCode = /^[A-Z0-9]{6}$/.test(sessionCode.toUpperCase());

  // Detect relay availability on mount
  useEffect(() => {
    isRelayAvailable(DEFAULT_RELAY_URL).then((available) => {
      setRelayMode(available ? "remote" : "local");
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      relayRef.current?.disconnect();
    };
  }, []);

  const handleJoin = useCallback(() => {
    if (!isValidCode) return;

    const code = sessionCode.toUpperCase();
    const mode = relayMode ?? "local";
    setPhase("connecting");
    setStatusMessage("Connecting to ceremony session…");

    try {
      const relay = createRelay({
        mode,
        participantId: 0, // will be assigned by the session
        isCoordinator: false,
        deviceName: navigator.userAgent.includes("Mobile") ? "Mobile Device" : "Browser",
        deviceType: navigator.userAgent.includes("Mobile") ? "mobile" : "browser",
        relayUrl: DEFAULT_RELAY_URL,
        sessionId: code,
        events: {
          onParticipantJoined: (p) => {
            // When we receive our own participant assignment
            if (p.participantId > 0 && participantId === 0) {
              setParticipantId(p.participantId);
            }
          },
          onStartDkg: (threshold: number, participants: number) => {
            setDkgParams({ threshold, participants });
            // The DKG will be started automatically when params arrive
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
            setPhase("error");
            setErrorMessage(error);
          },
        },
        onConnectionStateChange: (state) => {
          setConnectionState(state);
          if (state === "connected") {
            setPhase("waiting");
            setStatusMessage("Connected — waiting for ceremony to start…");
          } else if (state === "failed") {
            setPhase("error");
            setErrorMessage("Connection to relay server failed");
          }
        },
      });

      relayRef.current = relay;
      relay.connect();

      if (mode === "remote") {
        relay.joinSession(code);
      } else {
        // Local mode — set waiting immediately
        setPhase("waiting");
        setStatusMessage("Connected — waiting for ceremony to start…");
      }
    } catch {
      setPhase("error");
      setErrorMessage("Failed to connect to ceremony session");
    }
  }, [isValidCode, sessionCode, relayMode, participantId]);

  // Start DKG when params arrive from coordinator
  useEffect(() => {
    if (!dkgParams || !relayRef.current || phase === "running") return;
    if (participantId === 0) return; // wait for assignment

    setPhase("running");
    setStatusMessage("DKG ceremony in progress…");
    setProgress(10);

    const handleProgress = (p: DkgOrchestratorProgress) => {
      setProgress(Math.round(p.progress));
      setStatusMessage(p.message);
    };

    const orchestrator = new DkgOrchestrator({
      relay: relayRef.current,
      participantId,
      threshold: dkgParams.threshold,
      totalParticipants: dkgParams.participants,
      onProgress: handleProgress,
    });
    orchestratorRef.current = orchestrator;

    orchestrator.run()
      .then((result) => {
        setPhase("complete");
        setProgress(100);
        setStatusMessage("Ceremony complete — vault created!");

        try {
          sessionStorage.setItem(
            "vaulkyrie_dkg_result",
            JSON.stringify({
              groupPublicKeyHex: result.groupPublicKeyHex,
              publicKeyPackage: result.publicKeyPackageJson,
              keyPackages: { [result.participantId]: result.keyPackageJson },
              threshold: result.threshold,
              participants: result.totalParticipants,
              createdAt: Date.now(),
            }),
          );
        } catch { /* sessionStorage may be unavailable */ }
      })
      .catch((err: unknown) => {
        setPhase("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      });
  }, [dkgParams, participantId, phase]);

  const handleComplete = () => {
    const dkgRaw = sessionStorage.getItem("vaulkyrie_dkg_result");
    if (dkgRaw) {
      try {
        const parsed = JSON.parse(dkgRaw);
        onComplete(parsed.groupPublicKeyHex);
        return;
      } catch { /* fall through */ }
    }
    onComplete();
  };

  return (
    <div className="flex flex-col h-full bg-background p-5 gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="text-lg font-semibold">Join Ceremony</h2>
        {/* Relay mode badge */}
        <span className={`ml-auto inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium ${
          relayMode === "remote"
            ? "bg-success/15 text-success"
            : relayMode === "local"
              ? "bg-warning/15 text-warning"
              : "bg-muted text-muted-foreground"
        }`}>
          {relayMode === "remote" ? <Wifi className="h-2.5 w-2.5" /> : relayMode === "local" ? <WifiOff className="h-2.5 w-2.5" /> : <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {relayMode === "remote" ? "Cross-device" : relayMode === "local" ? "Same-browser" : "…"}
        </span>
      </div>

      {/* Logo */}
      <div className="flex justify-center py-4">
        <div className="relative">
          <div className="absolute -inset-3 rounded-full bg-primary/20 blur-lg animate-pulse" />
          <img
            src={logo}
            alt="Vaulkyrie"
            className="h-16 w-16 rounded-2xl relative z-10 shadow-lg shadow-primary/30"
          />
        </div>
      </div>

      {phase === "enter-code" && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4"
        >
          <Card className="p-4">
            <p className="text-sm font-medium mb-2">Enter Session Code</p>
            <p className="text-xs text-muted-foreground mb-4">
              Ask the vault creator for the 6-character session code shown on
              their screen or scan their QR code.
            </p>
            <Input
              value={sessionCode}
              onChange={(e) => setSessionCode(e.target.value.toUpperCase().slice(0, 6))}
              placeholder="e.g. YWNFNL"
              className="font-mono text-center text-lg tracking-widest"
              maxLength={6}
            />
          </Card>

          <Button
            onClick={handleJoin}
            disabled={!isValidCode}
            className="w-full"
          >
            <Users className="h-4 w-4 mr-2" />
            Join Ceremony
          </Button>

          <p className="text-[10px] text-muted-foreground text-center">
            {relayMode === "remote"
              ? "Cross-device relay detected — you can join from any device."
              : "Relay server not detected — both devices must be on the same browser."}
          </p>
        </motion.div>
      )}

      {(phase === "connecting" || phase === "waiting" || phase === "running") && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-4 flex-1 justify-center"
        >
          <div className="relative">
            <Loader2 className="h-10 w-10 text-primary animate-spin" />
            <Wifi className="h-4 w-4 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          </div>

          <p className="text-sm font-medium text-center">{statusMessage}</p>

          {phase === "running" && (
            <div className="w-full max-w-xs">
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-primary rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.5 }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground text-center mt-1">
                {progress}% complete
              </p>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Session: {sessionCode}
          </p>
        </motion.div>
      )}

      {phase === "complete" && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-4 flex-1 justify-center"
        >
          <div className="h-16 w-16 rounded-full bg-emerald-500/20 flex items-center justify-center">
            <Check className="h-8 w-8 text-emerald-400" />
          </div>
          <p className="text-lg font-semibold">Ceremony Complete</p>
          <p className="text-sm text-muted-foreground text-center">
            Your vault keys have been distributed. You can now use the wallet.
          </p>
          <Button onClick={handleComplete} className="w-full mt-4">
            Open Wallet
          </Button>
        </motion.div>
      )}

      {phase === "error" && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-4 flex-1 justify-center"
        >
          <div className="h-16 w-16 rounded-full bg-destructive/20 flex items-center justify-center">
            <AlertTriangle className="h-8 w-8 text-destructive" />
          </div>
          <p className="text-lg font-semibold">Connection Failed</p>
          <p className="text-sm text-muted-foreground text-center">
            {errorMessage}
          </p>
          <div className="flex gap-2 w-full mt-4">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                setPhase("enter-code");
                setErrorMessage("");
                relayRef.current?.disconnect();
                relayRef.current = null;
              }}
            >
              Try Again
            </Button>
            <Button variant="outline" className="flex-1" onClick={onBack}>
              Go Back
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  );
}
