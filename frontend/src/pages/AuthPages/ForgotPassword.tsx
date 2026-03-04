import { Link } from "react-router";
import PageMeta from "../../components/common/PageMeta";
import AuthLayout from "./AuthPageLayout";
import { ChevronLeftIcon } from "../../icons";

export default function ForgotPassword() {
  return (
    <>
      <PageMeta
        title="Forgot Password | UniSell"
        description="Reset your UniSell password."
      />
      <AuthLayout>
        <div className="flex flex-col flex-1">
          <div className="w-full max-w-md pt-10 mx-auto">
            <Link
              to="/signin"
              className="inline-flex items-center text-sm text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
            >
              <ChevronLeftIcon className="size-5" />
              Back to sign in
            </Link>
          </div>
          <div className="flex flex-col justify-center flex-1 w-full max-w-md mx-auto">
            <div>
              <h1 className="mb-2 font-semibold text-gray-800 text-title-sm dark:text-white/90 sm:text-title-md">
                Forgot Password
              </h1>
              <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
                Password reset is not available yet. Please contact your administrator or support to reset your password.
              </p>
              <Link
                to="/signin"
                className="inline-flex items-center justify-center px-4 py-3 text-sm font-medium text-white rounded-lg bg-brand-500 hover:bg-brand-600"
              >
                Return to sign in
              </Link>
            </div>
          </div>
        </div>
      </AuthLayout>
    </>
  );
}
