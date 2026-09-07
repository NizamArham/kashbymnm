import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

interface Props {
  children: React.ReactNode;
  adminOnly?: boolean;
}

export default function ProtectedRoute({ children, adminOnly }: Props) {
  const { user, loading } = useAuth();

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;

  // Enforced here for UI convenience only — the backend enforces the same
  // restriction independently, so this can never be bypassed for real.
  if (adminOnly && user.role !== "admin") {
    return <Navigate to="/pos" replace />;
  }

  return <>{children}</>;
}
