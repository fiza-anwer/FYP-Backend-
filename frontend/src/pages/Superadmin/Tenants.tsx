import { useEffect, useState } from "react";
import { authApi, type TenantRow } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import Button from "../../components/ui/button/Button";

export default function SuperadminTenants() {
  const { user, isSuperadmin } = useAuth();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    if (!isSuperadmin) return;
    let cancelled = false;
    authApi
      .getTenants()
      .then((list) => {
        if (!cancelled) setTenants(Array.isArray(list) ? list : []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load tenants");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSuperadmin]);

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      await authApi.approveTenant(id);
      setTenants((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: "approved" } : t))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: string) => {
    setActionLoading(id);
    try {
      await authApi.rejectTenant(id);
      setTenants((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: "rejected" } : t))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setActionLoading(null);
    }
  };

  if (!user) return null;
  if (!isSuperadmin) {
    return (
      <div className="p-4 text-gray-600 dark:text-gray-400">
        You do not have access to this page.
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-gray-800 dark:text-white">
        Tenant Management
      </h1>
      {error && (
        <div className="p-3 mb-4 text-sm text-red-700 bg-red-100 rounded-lg dark:bg-red-900/30 dark:text-red-400">
          {error}
        </div>
      )}
      {loading ? (
        <p className="text-gray-500 dark:text-gray-400">Loading tenants...</p>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg dark:border-gray-700">
          <table className="w-full text-sm text-left text-gray-700 dark:text-gray-300">
            <thead className="text-xs uppercase bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3">Tenant name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <td className="px-4 py-3">{t.tenant_name}</td>
                  <td className="px-4 py-3">{t.email}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2 py-1 text-xs rounded ${
                        t.status === "approved"
                          ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                          : t.status === "rejected"
                          ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                          : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                      }`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {t.created_at
                      ? new Date(t.created_at).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-4 py-3 flex gap-2">
                    {t.status === "pending" && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => handleApprove(t.id)}
                          disabled={actionLoading !== null}
                        >
                          {actionLoading === t.id ? "..." : "Approve"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleReject(t.id)}
                          disabled={actionLoading !== null}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && tenants.length === 0 && (
        <p className="text-gray-500 dark:text-gray-400">No tenants yet.</p>
      )}
    </div>
  );
}
