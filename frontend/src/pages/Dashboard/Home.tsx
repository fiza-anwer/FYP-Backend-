import { useState, useEffect, useCallback } from "react";
import { Link, useLocation } from "react-router";
import PageMeta from "../../components/common/PageMeta";
import { useAuth } from "../../context/AuthContext";
import { tenantApi, authApi, type Order, type TenantRow } from "../../api/client";
import { BoxIconLine, GroupIcon } from "../../icons";

function formatTenantName(name: string | undefined): string {
  if (!name) return "";
  if (name.includes("_") && !name.includes(" ")) return name;
  return name
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export default function Home() {
  const { isSuperadmin, user } = useAuth();
  const location = useLocation();
  const dashboardTitle = isSuperadmin ? "UniSell" : (formatTenantName(user?.tenant_name) || "UniSell");
  const pageTitle = `Dashboard | ${dashboardTitle}`;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Tenant dashboard data
  const [companiesCount, setCompaniesCount] = useState(0);
  const [ordersCount, setOrdersCount] = useState(0);
  const [consignedCount, setConsignedCount] = useState(0);
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);

  // Superadmin dashboard data
  const [tenantsCount, setTenantsCount] = useState(0);
  const [pendingTenantsCount, setPendingTenantsCount] = useState(0);
  const [tenants, setTenants] = useState<TenantRow[]>([]);

  const loadData = useCallback(() => {
    let cancelled = false;
    setError("");
    setLoading(true);

    if (isSuperadmin) {
      authApi
        .getTenants()
        .then((list) => {
          if (cancelled) return;
          const arr = Array.isArray(list) ? list : [];
          setTenants(arr);
          setTenantsCount(arr.length);
          setPendingTenantsCount(arr.filter((t) => t.status === "pending").length);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load tenants");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else {
      Promise.all([
        tenantApi.getCompanies(),
        tenantApi.getOrders(),
        tenantApi.getConsignments(),
      ])
        .then(([companiesRes, ordersRes, consignmentsRes]) => {
          if (cancelled) return;
          const companies = Array.isArray(companiesRes?.companies) ? companiesRes.companies : [];
          const orders = Array.isArray(ordersRes?.orders) ? ordersRes.orders : [];
          const consignments = Array.isArray(consignmentsRes?.consignments) ? consignmentsRes.consignments : [];
          setCompaniesCount(companies.length);
          setOrdersCount(orders.length);
          setConsignedCount(orders.filter((o) => o.status === "consigned").length);
          setRecentOrders(orders.slice(0, 10));
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load dashboard data");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [isSuperadmin]);

  // Refetch when dashboard is shown (e.g. navigating back to /)
  useEffect(() => {
    if (location.pathname !== "/") return;
    const cleanup = loadData();
    return () => {
      if (typeof cleanup === "function") cleanup();
    };
  }, [location.pathname, isSuperadmin, loadData]);

  // Refetch when user returns to this tab (e.g. after creating orders/consignments elsewhere)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && location.pathname === "/") loadData();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [location.pathname, loadData]);

  if (loading) {
    return (
      <>
        <PageMeta title={pageTitle} description="Dashboard overview" />
        <div className="flex items-center justify-center min-h-[200px] text-gray-500 dark:text-gray-400">
          Loading...
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageMeta title={pageTitle} description="Dashboard overview" />
        <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      </>
    );
  }

  if (isSuperadmin) {
    return (
      <>
        <PageMeta title={pageTitle} description="Superadmin dashboard" />
        <div className="space-y-6">
          <h1 className="text-xl font-semibold text-gray-800 dark:text-white">Dashboard</h1>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6">
            <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/[0.03] md:p-6">
              <div className="flex items-center justify-center w-12 h-12 bg-gray-100 rounded-xl dark:bg-gray-800">
                <GroupIcon className="text-gray-800 size-6 dark:text-white/90" />
              </div>
              <div className="mt-5">
                <span className="text-sm text-gray-500 dark:text-gray-400">Total tenants</span>
                <h4 className="mt-2 font-bold text-gray-800 text-title-sm dark:text-white/90">
                  {tenantsCount}
                </h4>
              </div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/[0.03] md:p-6">
              <div className="flex items-center justify-center w-12 h-12 bg-amber-100 rounded-xl dark:bg-amber-900/30">
                <BoxIconLine className="text-amber-700 size-6 dark:text-amber-400" />
              </div>
              <div className="mt-5">
                <span className="text-sm text-gray-500 dark:text-gray-400">Pending approval</span>
                <h4 className="mt-2 font-bold text-gray-800 text-title-sm dark:text-white/90">
                  {pendingTenantsCount}
                </h4>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/[0.03] md:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-800 dark:text-white/90">Tenants</h3>
              <Link
                to="/superadmin/tenants"
                className="text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                Manage tenants
              </Link>
            </div>
            {tenants.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400">No tenants yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left text-gray-700 dark:text-gray-300">
                  <thead className="text-xs uppercase bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                    <tr>
                      <th className="px-4 py-3">Tenant</th>
                      <th className="px-4 py-3">Email</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {tenants.slice(0, 10).map((t) => (
                      <tr key={t.id} className="bg-white dark:bg-gray-900">
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                          {t.tenant_name}
                        </td>
                        <td className="px-4 py-3">{t.email}</td>
                        <td className="px-4 py-3">
                          <span
                            className={
                              t.status === "approved"
                                ? "text-green-600 dark:text-green-400"
                                : t.status === "rejected"
                                ? "text-red-600 dark:text-red-400"
                                : "text-amber-600 dark:text-amber-400"
                            }
                          >
                            {t.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageMeta title={pageTitle} description="Dashboard overview" />
      <div className="space-y-6">
        <h1 className="text-xl font-semibold text-gray-800 dark:text-white">Dashboard</h1>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 md:gap-6">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/[0.03] md:p-6">
            <div className="flex items-center justify-center w-12 h-12 bg-gray-100 rounded-xl dark:bg-gray-800">
              <GroupIcon className="text-gray-800 size-6 dark:text-white/90" />
            </div>
            <div className="mt-5">
              <span className="text-sm text-gray-500 dark:text-gray-400">Companies</span>
              <h4 className="mt-2 font-bold text-gray-800 text-title-sm dark:text-white/90">
                {companiesCount}
              </h4>
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/[0.03] md:p-6">
            <div className="flex items-center justify-center w-12 h-12 bg-gray-100 rounded-xl dark:bg-gray-800">
              <BoxIconLine className="text-gray-800 size-6 dark:text-white/90" />
            </div>
            <div className="mt-5">
              <span className="text-sm text-gray-500 dark:text-gray-400">Total orders</span>
              <h4 className="mt-2 font-bold text-gray-800 text-title-sm dark:text-white/90">
                {ordersCount}
              </h4>
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/[0.03] md:p-6">
            <div className="flex items-center justify-center w-12 h-12 bg-blue-100 rounded-xl dark:bg-blue-900/30">
              <BoxIconLine className="text-blue-700 size-6 dark:text-blue-400" />
            </div>
            <div className="mt-5">
              <span className="text-sm text-gray-500 dark:text-gray-400">Consigned</span>
              <h4 className="mt-2 font-bold text-gray-800 text-title-sm dark:text-white/90">
                {consignedCount}
              </h4>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/[0.03] md:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-white/90">Recent orders</h3>
            <Link
              to="/orders"
              className="text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              View all orders
            </Link>
          </div>
          {recentOrders.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">No orders yet. Orders will appear here after your store integration imports them.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left text-gray-700 dark:text-gray-300">
                <thead className="text-xs uppercase bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                  <tr>
                    <th className="px-4 py-3">Order #</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Company</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {recentOrders.map((o) => (
                    <tr key={o.id} className="bg-white dark:bg-gray-900">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                        {o.order_number ?? o.external_id ?? "—"}
                      </td>
                      <td className="px-4 py-3">{o.email ?? "—"}</td>
                      <td className="px-4 py-3">{o.company_name ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            o.status === "dispatched"
                              ? "text-green-600 dark:text-green-400"
                              : o.status === "consigned"
                              ? "text-blue-600 dark:text-blue-400"
                              : "text-gray-600 dark:text-gray-400"
                          }
                        >
                          {o.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {typeof o.total === "number" ? o.total.toFixed(2) : o.total ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
