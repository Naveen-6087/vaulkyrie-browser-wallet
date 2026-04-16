import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Users, Loader2, Check, AlertTriangle, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import logo from "@/assets/xlogo.jpeg";

interface JoinCeremonyProps {
  onComplete: (groupPublicKey?: string) => void;
  onBack: () => void;
}

type JoinPhase = "enter-code" | "connecting" | "waiting" | "running" | "complete" | "error";

export function JoinCeremony({ onComplete, onBack }: JoinCeremonyProps) {
  const [sessionCode, setSessionCode] = useState("");
  const [phase, setPhase] = useState<JoinPhase>("enter-code");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const isValidCode = /^[A-Z0-9]{6}$/.test(sessionCode.toUpperCase());

  useEffect(() => {
    return () => {
      channelRef.current?.close();
    };
  }, []);

  const handleJoin = () => {
    if (!isValidCode) return;

    const code = sessionCode.toUpperCase();
    setPhase("connecting");
    setStatusMessage("Connecting to ceremony session...");

    try {
      const channel = new BroadcastChannel(`vaulkyrie-dkg-${code}`);
      channelRef.current = channel;

      channel.postMessage({
        type: "join-request",
        participantId: crypto.randomUUID(),
        timestamp: Date.now(),
      });

      setPhase("waiting");
      setStatusMessage("Connected — waiting for ceremony to start...");

      channel.onmessage = (event) => {
        const msg = event.data;

        switch (msg.type) {
          case "ceremony-start":
            setPhase("running");
            setStatusMessage("DKG ceremony in progress...");
            setProgress(10);
            break;

          case "dkg-progress":
            setProgress(msg.progress ?? 50);
            setStatusMessage(msg.message ?? "Processing...");
            break;

          case "dkg-complete":
            setPhase("complete");
            setProgress(100);
            setStatusMessage("Ceremony complete — vault created!");

            if (msg.result) {
              sessionStorage.setItem(
                "vaulkyrie_dkg_result",
                JSON.stringify(msg.result),
              );
            }
            break;

          case "ceremony-error":
            setPhase("error");
            setErrorMessage(msg.message ?? "Ceremony failed");
            break;

          default:
            break;
        }
      };

      channel.onmessageerror = () => {
        setPhase("error");
        setErrorMessage("Communication error with ceremony host");
      };
    } catch {
      setPhase("error");
      setErrorMessage("Failed to connect to ceremony session");
    }
  };

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
            Both devices must be on the same browser (same machine) for
            BroadcastChannel pairing. Cross-device pairing requires WebSocket
            relay (coming soon).
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
