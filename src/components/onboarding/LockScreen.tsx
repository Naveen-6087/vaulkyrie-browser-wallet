import { useState } from "react";
import { motion } from "framer-motion";
import { Lock, Eye, EyeOff, Fingerprint, Loader2 } from "lucide-react";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { useWalletStore } from "@/store/walletStore";
import logo from "@/assets/xlogo.jpeg";

interface LockScreenProps {
  onUnlock: () => void;
}

export function LockScreen({ onUnlock }: LockScreenProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const { passwordHash, passwordSalt, setPasswordHash } = useWalletStore();
  const isSetup = !passwordHash;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    if (isSetup) {
      if (password.length < 6) {
        setError("Password must be at least 6 characters");
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords don't match");
        return;
      }
      setLoading(true);
      try {
        const { hash, salt } = await hashPassword(password);
        setPasswordHash(hash, salt);
        onUnlock();
      } catch {
        setError("Failed to set password");
      } finally {
        setLoading(false);
      }
    } else {
      if (!password) {
        setError("Enter your password");
        return;
      }
      setLoading(true);
      try {
        const valid = await verifyPassword(password, passwordHash!, passwordSalt!);
        if (valid) {
          onUnlock();
        } else {
          setError("Incorrect password");
        }
      } catch {
        setError("Verification failed");
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full bg-background px-6">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-64 bg-primary/8 rounded-full blur-3xl pointer-events-none" />

      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="relative mb-6"
      >
        <div className="absolute -inset-3 bg-primary/15 rounded-2xl blur-xl animate-pulse" />
        <img
          src={logo}
          alt="Vaulkyrie"
          className="h-16 w-16 rounded-2xl relative z-10 shadow-lg shadow-primary/20"
        />
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="text-center mb-8"
      >
        <h1 className="text-xl font-bold tracking-tight mb-1">
          <span className="text-foreground">VAUL</span>
          <span className="text-primary">KYRIE</span>
        </h1>
        <p className="text-xs text-muted-foreground">
          {isSetup ? "Create a password to secure your wallet" : "Enter password to unlock"}
        </p>
      </motion.div>

      <motion.form
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        onSubmit={handleSubmit}
        className="w-full max-w-[280px]"
      >
        <div className="relative mb-3">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(""); }}
            placeholder={isSetup ? "New password (min 6 chars)" : "Password"}
            autoFocus
            className={`w-full pl-10 pr-10 py-3 rounded-xl bg-card border text-sm
                       focus:outline-none focus:ring-2 transition-all
                       placeholder:text-muted-foreground/50
                       ${error
                         ? "border-destructive focus:ring-destructive/40"
                         : "border-border focus:ring-primary/40 focus:border-primary/60"
                       }`}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        {isSetup && (
          <div className="relative mb-3">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setError(""); }}
              placeholder="Confirm password"
              className="w-full pl-10 pr-4 py-3 rounded-xl bg-card border text-sm
                         focus:outline-none focus:ring-2 transition-all
                         placeholder:text-muted-foreground/50
                         border-border focus:ring-primary/40 focus:border-primary/60"
            />
          </div>
        )}

        {error && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-xs text-destructive text-center mb-3"
          >
            {error}
          </motion.p>
        )}

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-xl font-semibold text-sm cursor-pointer
                     bg-primary text-primary-foreground disabled:opacity-50
                     shadow-lg shadow-primary/20 hover:shadow-primary/35 transition-shadow
                     flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {isSetup ? "Set Password" : "Unlock"}
        </motion.button>
      </motion.form>

      {!isSetup && (
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="mt-6 flex flex-col items-center gap-1.5 text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer"
        >
          <Fingerprint className="h-6 w-6" />
          <span className="text-[10px]">Use biometrics</span>
        </motion.button>
      )}
    </div>
  );
}
