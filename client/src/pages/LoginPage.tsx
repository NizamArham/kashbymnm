import { useState, FormEvent, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ShoppingBag, AlertCircle } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { ApiRequestError } from "../lib/api";
import { Input } from "../components/ui";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Every time the error changes — set or cleared — the alert replays
  // its entrance. Makes a second failed attempt feel responsive even
  // when the message is identical to the first.
  const [errorKey, setErrorKey] = useState(0);

  useEffect(() => {
    if (error) setErrorKey((k) => k + 1);
  }, [error]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!username.trim() || !password) {
      setError("Enter both username and password.");
      return;
    }

    setSubmitting(true);
    try {
      const user = await login(username.trim(), password);

      if (user) {
        navigate("/", { replace: true });
      } else {
        setError("Sign in didn't complete. Please try again.");
      }
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Couldn't reach the server. Check your connection and try again."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-black overflow-hidden">
      {/* ----------------------------------------------------------------
          AMBIENT BACKGROUND — on a real desktop width, flat black either
          side of the card read as empty rather than minimal. A faint dot
          grid plus two soft glows give the space atmosphere without
          competing with the actual form. Fully behind the content layer
          below (z-10) and inert to clicks.
      ---------------------------------------------------------------- */}
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }}
      />
      <div className="pointer-events-none absolute -top-40 -left-40 w-[560px] h-[560px] bg-white/[0.06] rounded-full blur-3xl" />
      <div className="pointer-events-none absolute -bottom-48 -right-32 w-[640px] h-[640px] bg-white/[0.05] rounded-full blur-3xl" />

      <div className="relative z-10 max-w-[1600px] mx-auto min-h-screen flex flex-col lg:flex-row">
      {/* ----------------------------------------------------------------
          LEFT PANEL — the brand column. Appears FIRST on mobile (top
          of the page), on the LEFT on desktop. Black canvas, white ink,
          quiet and confident.

          Content is spread top / middle / bottom via justify-between so
          the wordmark sits at the top, the tagline is centered in the
          available space, and the copyright anchors the bottom.
      ---------------------------------------------------------------- */}
      <div className="lg:w-2/5 text-white flex flex-col justify-between p-8 lg:p-12 min-h-[260px] lg:min-h-0">
        {/* Wordmark */}
        <div className="flex items-center gap-3">
          <ShoppingBag size={28} className="text-white lg:hidden" />
          <ShoppingBag size={32} className="text-white hidden lg:block" />
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight flex items-baseline gap-2">
            Kash
            <span className="text-xs lg:text-sm italic font-light text-gray-400">
              by M&amp;M
            </span>
          </h1>
        </div>

        {/* Tagline */}
        <div className="space-y-3 my-8 lg:my-0">
          <p className="text-2xl lg:text-4xl font-semibold leading-tight tracking-tight">
            Everything the shop does.
            <span className="block text-white/40 font-normal mt-2 text-base lg:text-2xl">
              Built because nothing else fit.
            </span>
          </p>
        </div>

        {/* Copyright */}
        <p className="text-xs text-white/30">
          &copy; {new Date().getFullYear()} M&amp;M Clothing
        </p>
      </div>

      {/* ----------------------------------------------------------------
          RIGHT PANEL — the login column. Also on black, but hosts the
          login card. The card surface is bg-neutral-50 rather than pure
          white — 2% off, which keeps the sharp contrast against black
          while softening the glare on brighter screens. Content inside
          stays exactly the same.
      ---------------------------------------------------------------- */}
      <div className="flex-1 flex items-center justify-center px-6 py-10 lg:px-16 lg:py-0">
        <div className="w-full max-w-md bg-neutral-50 rounded-3xl shadow-2xl p-8 sm:p-12">
          {/* Heading */}
          <div className="mb-8">
            <h2 className="text-2xl font-semibold text-black tracking-tight">
              Sign in
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Enter your credentials to continue.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="username" className="block text-xs font-medium text-black uppercase tracking-wider mb-2">
                Username
              </label>
              <Input
                id="username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (error) setError(null);
                }}
                autoFocus
                autoComplete="username"
                className={`!py-3 !text-base !rounded-lg transition-shadow ${
                  error ? "!border-red-300 !ring-2 !ring-red-500/10" : ""
                }`}
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-medium text-black uppercase tracking-wider mb-2">
                Password
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(null);
                }}
                autoComplete="current-password"
                className={`!py-3 !text-base !rounded-lg transition-shadow ${
                  error ? "!border-red-300 !ring-2 !ring-red-500/10" : ""
                }`}
              />
            </div>

            {/* Error — slim inline line, replays on each new attempt. */}
            {error && (
              <p
                key={errorKey}
                role="alert"
                className="flex items-center gap-1.5 text-sm text-red-600 animate-[errorIn_0.3s_ease-out]"
              >
                <AlertCircle size={14} className="flex-shrink-0" />
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-black text-white font-medium rounded-lg py-3.5 text-sm tracking-wide hover:bg-gray-800 active:scale-[0.99] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed mt-2"
            >
              {submitting ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
      </div>

      {/* Inline keyframes for the error line — fades in with a quick,
          settling shake. Tailwind doesn't ship one, so define it locally. */}
      <style>{`
        @keyframes errorIn {
          0% { opacity: 0; transform: translateX(0); }
          20% { opacity: 1; transform: translateX(-3px); }
          40% { transform: translateX(3px); }
          60% { transform: translateX(-2px); }
          80% { transform: translateX(2px); }
          100% { transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}