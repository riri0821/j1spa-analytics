"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { User, Lock, Eye, EyeOff, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const [view, setView] = useState("login"); // "login" | "forgot"
  const [infoMessage, setInfoMessage] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("deactivated")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setErrorMessage("This account has been deactivated. Contact the owner.");
    } else if (params.get("error") === "invalid_reset_link") {
      setErrorMessage("That reset link is invalid or has expired. Request a new one below.");
    } else if (params.get("reset") === "success") {
      setInfoMessage("Password updated. Log in with your new password.");
    }
  }, []);

  async function handleForgotSubmit(e) {
    e.preventDefault();
    setErrorMessage("");
    setForgotSubmitting(true);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErrorMessage(body.error || "Something went wrong. Try again.");
        setForgotSubmitting(false);
        return;
      }
      setForgotSent(true);
    } catch {
      setErrorMessage("Something went wrong. Try again.");
    }
    setForgotSubmitting(false);
  }

  function backToLogin() {
    setView("login");
    setErrorMessage("");
    setInfoMessage("");
    setForgotSent(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErrorMessage("");
    setIsSubmitting(true);

    let body;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      body = await res.json();
      if (!res.ok) {
        setErrorMessage(body.error || "Something went wrong. Try again.");
        setIsSubmitting(false);
        return;
      }
    } catch {
      setErrorMessage("Something went wrong. Try again.");
      setIsSubmitting(false);
      return;
    }

    setPassword("");
    router.push(body.redirectTo);
    router.refresh();
  }

  const banners = (
    <AnimatePresence>
      {errorMessage && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="mt-6 flex items-center gap-2 rounded-lg border border-[#d03b3b]/20 bg-[#d03b3b]/10 p-3 text-xs text-[#d03b3b]"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </motion.div>
      )}
      {!errorMessage && infoMessage && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="mt-6 flex items-center gap-2 rounded-lg border border-[#22c55e]/20 bg-[#22c55e]/10 p-3 text-xs text-[#22c55e]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{infoMessage}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );

  const formFields =
    view === "forgot" ? (
      <>
        {banners}

        {forgotSent ? (
          <div className="mt-6 flex flex-col gap-5">
            <div className="flex items-center gap-2 rounded-lg border border-[#22c55e]/20 bg-[#22c55e]/10 p-3 text-xs text-[#22c55e]">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>If that&apos;s the owner&apos;s account email, reset instructions have been sent to it.</span>
            </div>
            <button
              type="button"
              onClick={backToLogin}
              className="text-xs font-medium text-[#9aa3b2] transition-colors hover:text-[#f5f6f8]"
            >
              Back to login
            </button>
          </div>
        ) : (
          <form onSubmit={handleForgotSubmit} className="mt-6 flex flex-col gap-5">
            <p className="text-xs text-[#9aa3b2]">
              Enter the account email. Only the owner&apos;s email can request a reset - staff password resets are
              handled by the owner in Settings.
            </p>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[#9aa3b2]">Email</label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6b7280]" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (errorMessage) setErrorMessage("");
                  }}
                  placeholder="owner@example.com"
                  className="w-full rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0d1119] py-3 pl-10 pr-4 text-sm text-[#f5f6f8] transition-colors placeholder:text-[#6b7280] focus:border-[#22c55e] focus:outline-none focus:ring-1 focus:ring-[#22c55e]/50"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={forgotSubmitting}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-[#22c55e] py-3 text-sm font-semibold text-[#05230f] shadow-lg transition hover:brightness-110 disabled:opacity-60"
            >
              {forgotSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Sending...</span>
                </>
              ) : (
                <span>Send reset instructions</span>
              )}
            </button>

            <button
              type="button"
              onClick={backToLogin}
              className="text-xs font-medium text-[#9aa3b2] transition-colors hover:text-[#f5f6f8]"
            >
              Back to login
            </button>
          </form>
        )}
      </>
    ) : (
      <>
        {banners}

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-5">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#9aa3b2]">Email</label>
            <div className="relative">
              <User className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6b7280]" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errorMessage) setErrorMessage("");
                }}
                placeholder="you@example.com"
                autoComplete="email"
                className="w-full rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0d1119] py-3 pl-10 pr-4 text-sm text-[#f5f6f8] transition-colors placeholder:text-[#6b7280] focus:border-[#22c55e] focus:outline-none focus:ring-1 focus:ring-[#22c55e]/50"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#9aa3b2]">Password</label>
            <div className="relative">
              <Lock className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6b7280]" />
              <input
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errorMessage) setErrorMessage("");
                }}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0d1119] py-3 pl-10 pr-10 text-sm text-[#f5f6f8] transition-colors placeholder:text-[#6b7280] focus:border-[#22c55e] focus:outline-none focus:ring-1 focus:ring-[#22c55e]/50"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#6b7280] transition-colors hover:text-[#f5f6f8]"
              >
                {showPassword ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </button>
            </div>
            <div className="mt-1.5 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setView("forgot");
                  setErrorMessage("");
                  setInfoMessage("");
                }}
                className="text-xs font-medium text-[#9aa3b2] transition-colors hover:text-[#22c55e]"
              >
                Forgot password?
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-[#22c55e] py-3 text-sm font-semibold text-[#05230f] shadow-lg transition hover:brightness-110 disabled:opacity-60"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Signing in...</span>
              </>
            ) : (
              <span>Log In</span>
            )}
          </button>
        </form>
      </>
    );

  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-y-auto bg-[#05070c] px-6 py-16 text-[#f5f6f8]">
      <div className="w-full max-w-sm">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-[#f5f6f8]">J1SPA Analytics</h1>
          <p className="mt-2 text-sm text-[#9aa3b2]">Owner &amp; Staff Portal</p>
        </div>
        <h2 className="mt-8 text-xl font-bold text-center text-[#f5f6f8]">
          {view === "forgot" ? "Forgot password" : "Login"}
        </h2>
        {formFields}
      </div>
    </div>
  );
}
