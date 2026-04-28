import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Lock, Eye, EyeOff, Loader2 } from "lucide-react";
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
  const [now, setNow] = useState(Date.now());

  const {
    passwordHash,
    passwordSalt,
    setPasswordHash,
    registerUnlockFailure,
    resetUnlockFailures,
    unlockBlockedUntil,
  } = useWalletStore();
  const isSetup = !passwordHash;
  const remainingLockMs = unlockBlockedUntil && unlockBlockedUntil > now ? unlockBlockedUntil - now : 0;
  const isBlocked = remainingLockMs > 0;

  useEffect(() => {
    if (!isBlocked) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isBlocked]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || isBlocked) return;

    if (isSetup) {
      if (password.length < 10) {
        setError("Password must be at least 10 characters");
        return;
      }
      if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        setError("Use at least one letter and one number");
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
          resetUnlockFailures();
          onUnlock();
        } else {
          const { blockedUntil } = registerUnlockFailure();
          if (blockedUntil && blockedUntil > Date.now()) {
            const waitSeconds = Math.ceil((blockedUntil - Date.now()) / 1000);
            setError(`Too many attempts. Try again in ${waitSeconds}s`);
          } else {
            setError("Incorrect password");
          }
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
        <label htmlFor="wallet-password" className="sr-only">
          {isSetup ? "Create password" : "Wallet password"}
        </label>
        <div className="relative mb-3">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            id="wallet-password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(""); }}
            placeholder={isSetup ? "New password (min 10 chars)" : "Password"}
            autoComplete={isSetup ? "new-password" : "current-password"}
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
          <>
            <label htmlFor="wallet-password-confirm" className="sr-only">
              Confirm password
            </label>
            <div className="relative mb-3">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                id="wallet-password-confirm"
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(""); }}
                placeholder="Confirm password"
                autoComplete="new-password"
                className="w-full pl-10 pr-4 py-3 rounded-xl bg-card border text-sm
                          focus:outline-none focus:ring-2 transition-all
                          placeholder:text-muted-foreground/50
                          border-border focus:ring-primary/40 focus:border-primary/60"
              />
            </div>
          </>
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

        {isBlocked && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-xs text-muted-foreground text-center mb-3"
          >
            Unlock disabled for {Math.max(1, Math.ceil(remainingLockMs / 1000))}s after repeated failures.
          </motion.p>
        )}

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          type="submit"
          disabled={loading || isBlocked}
          className="w-full py-3 rounded-xl font-semibold text-sm cursor-pointer
                     bg-primary text-primary-foreground disabled:opacity-50
                     shadow-lg shadow-primary/20 hover:shadow-primary/35 transition-shadow
                     flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {isSetup ? "Set Password" : "Unlock"}
        </motion.button>
      </motion.form>
    </div>
  );
}
