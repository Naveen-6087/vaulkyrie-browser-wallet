import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
import { runLocalDkg } from "@/services/frost/frostService";
import type { FullDkgResult } from "@/services/frost/types";
import type { LocalDkgProgress } from "@/services/frost/frostService";
import {
  createRelay,
  generateSessionCode,
  buildQrPayload,
  DEFAULT_RELAY_URL,
  type RelayAdapter,
  type ConnectionState,
} from "@/services/relay/relayAdapter";
import type { RelayParticipant } from "@/services/relay/channelRelay";
import {
  DkgOrchestrator,
  type DkgOrchestratorProgress,
} from "@/services/frost/dkgOrchestrator";
import logo from "@/assets/xlogo.jpeg";

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

export function DKGCeremony({ config, onComplete, onBack }: DKGCeremonyProps) {
  const [phase, setPhase] = useState<CeremonyPhase>("pairing");
  const [sessionCode, setSessionCode] = useState(generateSessionCode);
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
  const [copied, setCopied] = useState(false);
  const [relayMode, setRelayMode] = useState<"local" | "remote" | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");

  const relayRef = useRef<RelayAdapter | null>(null);
  const orchestratorRef = useRef<DkgOrchestrator | null>(null);
  const dkgStartTimeRef = useRef<number>(0);
  const MIN_ANIMATION_MS = 4000;

  const allDevicesPaired = devices.filter((d) => d.status === "ready").length >= config.totalParticipants;

  // Detect relay availability on mount and set up relay
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const available = await isRelayAvailable(DEFAULT_RELAY_URL);
      if (cancelled) return;

      const mode = available ? "remote" : "local";
      setRelayMode(mode);

      const relay = createRelay({
        mode,
        participantId: 1, // coordinator is always participant 1
        isCoordinator: true,
        deviceName: "This Browser",
        relayUrl: DEFAULT_RELAY_URL,
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
            setDkgError(error);
            setPhase("pairing");
          },
        },
        onConnectionStateChange: setConnectionState,
        onSessionCreated: (code: string) => {
          console.log("[DKGCeremony] Session created:", code);
          // Update UI if server assigned a different code
          setSessionCode(code);
          setQrPayload(buildQrPayload(code, config.threshold, config.totalParticipants));
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

  const startDKG = useCallback(() => {
    setPhase("dkg-round1");
    setDkgProgress(0);
    setDkgError(null);
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
    await navigator.clipboard.writeText(sessionCode);
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
            {phase === "complete" && "Your threshold wallet is ready"}
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

                {/* Session code for manual entry */}
                <div className="flex items-center justify-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Or enter code:
                  </span>
                  <button
                    onClick={handleCopyCode}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted font-mono text-sm font-bold tracking-widest cursor-pointer hover:bg-accent transition-colors"
                  >
                    {sessionCode}
                    {copied ? (
                      <Check className="h-3 w-3 text-success" />
                    ) : (
                      <Copy className="h-3 w-3 text-muted-foreground" />
                    )}
                  </button>
                </div>
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
            onClick={() => onComplete(groupPublicKey)}
            className="w-full py-3.5 rounded-xl font-semibold text-sm cursor-pointer
                       bg-primary text-primary-foreground
                       shadow-lg shadow-primary/20 hover:shadow-primary/35 transition-all
                       flex items-center justify-center gap-2"
          >
            Open Vault
            <Shield className="h-4 w-4" />
          </motion.button>
        )}
      </div>
    </div>
  );
}
