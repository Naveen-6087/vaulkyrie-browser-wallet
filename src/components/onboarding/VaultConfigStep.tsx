import { useState } from "react";
import { motion } from "framer-motion";
import { Shield, Users, Lock, ArrowLeft, ArrowRight, Zap } from "lucide-react";

interface VaultConfigStepProps {
  onNext: (config: VaultConfig) => void;
  onBack: () => void;
}

export interface VaultConfig {
  vaultName: string;
  threshold: number;
  totalParticipants: number;
  cosigner?: {
    enabled: boolean;
    participantId: number;
  };
}

const PRESETS = [
  {
    threshold: 2,
    total: 2,
    label: "Fast Vault",
    desc: "This browser plus a Vaulkyrie server cosigner. Best for demos and single-device recovery.",
    icon: Zap,
    risk: "Assisted",
    riskColor: "text-success",
    cosigner: { enabled: true, participantId: 2 },
  },
  {
    threshold: 1,
    total: 3,
    label: "1 of 3",
    desc: "Any single device can sign. Best for personal use.",
    icon: Shield,
    risk: "Low security",
    riskColor: "text-warning",
  },
  {
    threshold: 2,
    total: 3,
    label: "2 of 3",
    desc: "Two devices must agree. Recommended for most users.",
    icon: Users,
    risk: "Balanced",
    riskColor: "text-primary",
    recommended: true,
  },
  {
    threshold: 3,
    total: 3,
    label: "3 of 3",
    desc: "All devices must sign. Maximum security, no redundancy.",
    icon: Lock,
    risk: "Maximum security",
    riskColor: "text-success",
  },
];

export function VaultConfigStep({ onNext, onBack }: VaultConfigStepProps) {
  const [vaultName, setVaultName] = useState("Main Vault");
  const [selectedPreset, setSelectedPreset] = useState(2);

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg hover:bg-card transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
        </button>
        <div>
          <h2 className="text-base font-semibold">Configure Vault</h2>
          <p className="text-xs text-muted-foreground">
            Step 1 of 3 · Threshold setup
          </p>
        </div>
      </div>

      <div className="flex flex-col flex-1 px-5 py-4 overflow-y-auto">
        <div className="mb-5">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Vault Name
          </label>
          <input
            type="text"
            value={vaultName}
            onChange={(e) => setVaultName(e.target.value)}
            placeholder="My Vault"
            className="w-full px-3 py-2.5 rounded-lg bg-card border border-border text-sm
                       focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60
                       placeholder:text-muted-foreground/50 transition-all"
          />
        </div>

        <div className="mb-4">
          <label className="text-xs font-medium text-muted-foreground mb-2.5 block">
            Signing Threshold
          </label>

          <div className="flex flex-col gap-2.5">
            {PRESETS.map((preset, i) => {
              const Icon = preset.icon;
              const isSelected = i === selectedPreset;

              return (
                <motion.button
                  key={i}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setSelectedPreset(i)}
                  className={`relative flex items-start gap-3 p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                    isSelected
                      ? "border-primary/60 bg-primary/8 shadow-sm shadow-primary/10"
                      : "border-border bg-card/50 hover:bg-card hover:border-border"
                  }`}
                >
                  {preset.recommended && (
                    <span className="absolute -top-2 right-3 px-2 py-0.5 text-[10px] font-bold rounded-full bg-primary text-primary-foreground">
                      RECOMMENDED
                    </span>
                  )}

                  <div
                    className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${
                      isSelected ? "bg-primary/20" : "bg-muted"
                    }`}
                  >
                    <Icon
                      className={`h-4.5 w-4.5 ${isSelected ? "text-primary" : "text-muted-foreground"}`}
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">
                        {preset.label}
                      </span>
                      <span className={`text-[10px] font-medium ${preset.riskColor}`}>
                        {preset.risk}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {preset.desc}
                    </p>
                  </div>

                  <div
                    className={`h-4 w-4 rounded-full border-2 shrink-0 mt-0.5 flex items-center justify-center ${
                      isSelected ? "border-primary" : "border-muted-foreground/30"
                    }`}
                  >
                    {isSelected && (
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        className="h-2 w-2 rounded-full bg-primary"
                      />
                    )}
                  </div>
                </motion.button>
              );
            })}
          </div>
        </div>

        <div className="bg-info/8 border border-info/20 rounded-lg p-3 mt-auto mb-4 shadow-[0_0_0_1px_rgba(78,205,196,0.05)]">
          <p className="text-xs text-info leading-relaxed">
            {PRESETS[selectedPreset].cosigner ? (
              <>
                <strong>How it works:</strong> Your signing key is split between this browser and
                the Vaulkyrie server cosigner.
              </>
            ) : (
              <>
                <strong>How it works:</strong> Your signing key is split into{" "}
                {PRESETS[selectedPreset].total} shares using FROST DKG. At least{" "}
                {PRESETS[selectedPreset].threshold} device
                {PRESETS[selectedPreset].threshold > 1 ? "s" : ""} must participate
                to sign.
              </>
            )}
          </p>
        </div>
      </div>

      <div className="px-5 pb-5">
        <motion.button
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.98 }}
          onClick={() =>
            onNext({
              vaultName,
              threshold: PRESETS[selectedPreset].threshold,
              totalParticipants: PRESETS[selectedPreset].total,
              cosigner: PRESETS[selectedPreset].cosigner,
            })
          }
          disabled={!vaultName.trim()}
          className="w-full py-3.5 rounded-xl font-semibold text-sm cursor-pointer
                     bg-primary text-primary-foreground
                     disabled:opacity-40 disabled:cursor-not-allowed
                     shadow-lg shadow-primary/20 hover:shadow-primary/35 transition-shadow
                     flex items-center justify-center gap-2"
        >
          Continue to Device Pairing
          <ArrowRight className="h-4 w-4" />
        </motion.button>
      </div>
    </div>
  );
}
