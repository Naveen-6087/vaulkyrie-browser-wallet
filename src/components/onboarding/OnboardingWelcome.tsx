import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, Users, Zap, ChevronRight } from "lucide-react";
import logo from "@/assets/xlogo.jpeg";
import banner from "@/assets/xbannerv.jpeg";

interface OnboardingWelcomeProps {
  onCreateVault: () => void;
  onImportVault: () => void;
  onJoinCeremony?: () => void;
}

const FEATURES = [
  {
    icon: Shield,
    title: "Quantum-Resistant",
    desc: "WOTS+ authority protects against quantum threats",
  },
  {
    icon: Users,
    title: "Threshold Signing",
    desc: "FROST DKG splits keys across multiple devices",
  },
  {
    icon: Zap,
    title: "Private Policies",
    desc: "Arcium MXE enforces rules without revealing them",
  },
];

export function OnboardingWelcome({
  onCreateVault,
  onImportVault,
  onJoinCeremony,
}: OnboardingWelcomeProps) {
  const [activeFeature, setActiveFeature] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveFeature((prev) => (prev + 1) % FEATURES.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Banner with teal glow */}
      <div className="relative h-48 overflow-hidden shrink-0">
        <img
          src={banner}
          alt="Vaulkyrie"
          className="w-full h-full object-cover opacity-60"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background" />
        <div className="absolute inset-0 bg-gradient-to-r from-primary/10 via-transparent to-primary/10" />

        {/* Logo centered */}
        <motion.div
          className="absolute inset-0 flex items-center justify-center"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        >
          <div className="relative">
            <div className="absolute -inset-4 rounded-full bg-primary/20 blur-xl animate-pulse" />
            <img
              src={logo}
              alt="Vaulkyrie Logo"
              className="h-20 w-20 rounded-2xl relative z-10 shadow-lg shadow-primary/30"
            />
          </div>
        </motion.div>
      </div>

      {/* Content */}
      <div className="flex flex-col flex-1 px-5 pt-3 pb-5">
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="text-center mb-4"
        >
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="text-foreground">VAUL</span>
            <span className="text-primary">KYRIE</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Threshold wallet for the post-quantum era
          </p>
        </motion.div>

        {/* Feature carousel */}
        <div className="bg-card/80 border border-border rounded-xl p-4 mb-5">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeFeature}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
              className="flex items-start gap-3"
            >
              {(() => {
                const Feature = FEATURES[activeFeature];
                const Icon = Feature.icon;
                return (
                  <>
                    <div className="h-10 w-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{Feature.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {Feature.desc}
                      </p>
                    </div>
                  </>
                );
              })()}
            </motion.div>
          </AnimatePresence>

          {/* Dots */}
          <div className="flex justify-center gap-1.5 mt-3">
            {FEATURES.map((_, i) => (
              <button
                key={i}
                onClick={() => setActiveFeature(i)}
                className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
                  i === activeFeature
                    ? "w-6 bg-primary"
                    : "w-1.5 bg-muted-foreground/30"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-3 mt-auto">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onCreateVault}
            className="relative overflow-hidden w-full py-3.5 rounded-xl font-semibold text-sm cursor-pointer
                       bg-primary text-primary-foreground
                       shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-shadow"
          >
            <span className="relative flex items-center justify-center gap-2">
              Create New Vault
              <ChevronRight className="h-4 w-4" />
            </span>
          </motion.button>

          <button
            onClick={onImportVault}
            className="w-full py-3 rounded-xl font-medium text-sm cursor-pointer
                       border border-border text-muted-foreground
                       hover:bg-card hover:text-foreground hover:border-primary/30 transition-all"
          >
            Import Existing Vault
          </button>

          {onJoinCeremony && (
            <button
              onClick={onJoinCeremony}
              className="w-full py-3 rounded-xl font-medium text-sm cursor-pointer
                         border border-border text-muted-foreground
                         hover:bg-card hover:text-foreground hover:border-primary/30 transition-all
                         flex items-center justify-center gap-2"
            >
              <Users className="h-4 w-4" />
              Join Existing Ceremony
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
