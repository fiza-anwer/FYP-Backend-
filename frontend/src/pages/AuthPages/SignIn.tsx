import { useEffect } from "react";
import { useNavigate } from "react-router";
import PageMeta from "../../components/common/PageMeta";
import AuthLayout from "./AuthPageLayout";
import SignInForm from "../../components/auth/SignInForm";
import { useAuth } from "../../context/AuthContext";
import { getToken } from "../../api/client";

export default function SignIn() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const token = getToken();
  useEffect(() => {
    if (token && user) {
      if (user.role === "superadmin") navigate("/superadmin/tenants", { replace: true });
      else navigate("/", { replace: true });
    }
  }, [token, user, navigate]);

  if (token && user) {
    return (
      <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f9fafb", color: "#374151" }}>
        <p>Redirecting…</p>
      </div>
    );
  }
  return (
    <>
      <PageMeta
        title="Sign In | UniSell"
        description="Sign in to UniSell"
      />
      <AuthLayout>
        <SignInForm />
      </AuthLayout>
    </>
  );
}
