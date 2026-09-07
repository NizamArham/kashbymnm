import { useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ShoppingBag } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { ApiRequestError } from "../lib/api";
import { Input, ErrorText } from "../components/ui";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!username.trim() || !password) {
      setError("Enter both username and password");
      return;
    }

    setSubmitting(true);
    try {
      await login(username.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not reach the server. Is it running?");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm bg-white border border-gray-200 rounded-2xl shadow-sm p-8">
        <div className="flex items-center gap-2 mb-1">
          <ShoppingBag size={22} className="text-black" />
          <h1 className="text-xl font-bold tracking-tight flex items-baseline gap-1">
            Kash
            <span className="text-xs italic font-light text-gray-400">by M&amp;M</span>
          </h1>
        </div>
        <p className="text-sm text-gray-400 mb-6">Sign in to the management system</p>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Username</label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </div>
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Password</label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>

          {error && <ErrorText>{error}</ErrorText>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full mt-2 bg-black text-white font-medium rounded-xl py-2.5 text-sm hover:bg-gray-800 transition-all duration-200 disabled:opacity-50"
          >
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
