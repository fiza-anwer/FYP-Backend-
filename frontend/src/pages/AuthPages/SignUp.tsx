import { useEffect } from "react";
import { useNavigate } from "react-router";
import PageMeta from "../../components/common/PageMeta";
import AuthLayout from "./AuthPageLayout";
import SignUpForm from "../../components/auth/SignUpForm";
import { useAuth } from "../../context/AuthContext";
import { getToken } from "../../api/client";

export default function SignUp() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const token = getToken();
  useEffect(() => {
    if (token && user) {
      if (user.role === "superadmin") navigate("/superadmin/tenants", { replace: true });
      else navigate("/", { replace: true });
    }
  }, [token, user, navigate]);

  if (token && user) return null;
  return (
    <>
      <PageMeta
        title="Sign Up | UniSell"
        description="Create your UniSell account"
      />
      <AuthLayout>
        <SignUpForm />
      </AuthLayout>
    </>
  );
}
