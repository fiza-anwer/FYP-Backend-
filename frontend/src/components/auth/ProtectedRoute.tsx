import { Outlet, useNavigate } from "react-router";
import { useEffect } from "react";
import { getToken } from "../../api/client";

/**
 * Protects routes that require JWT. Redirects to /signin if no token.
 */
export default function ProtectedRoute() {
  const navigate = useNavigate();
  const token = getToken();

  useEffect(() => {
    if (!token) {
      navigate("/signin", { replace: true });
    }
  }, [token, navigate]);

  if (!token) {
    return (
      <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f9fafb", color: "#374151" }}>
        <p>Redirecting to sign in…</p>
      </div>
    );
  }
  return <Outlet />;
}
