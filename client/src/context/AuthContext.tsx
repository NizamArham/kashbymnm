import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { api } from "../lib/api";
import { AuthUser } from "../lib/types";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<AuthUser>;
  logout: () => void;
  // An admin steps into a staff-level session to work the till, and back out with their password.
  enterCashierMode: () => Promise<AuthUser>;
  exitCashierMode: (password: string) => Promise<AuthUser>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storedUser = localStorage.getItem("mm_user");
    const storedToken = localStorage.getItem("mm_token");
    if (storedUser && storedToken) {
      setUser(JSON.parse(storedUser));
    }
    setLoading(false);
  }, []);

  async function login(username: string, password: string) {
    const result = await api.post<{ token: string; user: AuthUser }>("/auth/login", {
      username,
      password,
    });
    localStorage.setItem("mm_token", result.token);
    localStorage.setItem("mm_user", JSON.stringify(result.user));
    setUser(result.user);
    return result.user;
  }

  async function switchSession(path: string, body: unknown) {
    const result = await api.post<{ token: string; user: AuthUser }>(path, body);
    localStorage.setItem("mm_token", result.token);
    localStorage.setItem("mm_user", JSON.stringify(result.user));
    setUser(result.user);
    return result.user;
  }

  const enterCashierMode = () => switchSession("/auth/cashier-mode", {});
  const exitCashierMode = (password: string) => switchSession("/auth/exit-cashier-mode", { password });

  function logout() {
    localStorage.removeItem("mm_token");
    localStorage.removeItem("mm_user");
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, enterCashierMode, exitCashierMode }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
