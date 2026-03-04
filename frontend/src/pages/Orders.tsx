import { useState, useEffect } from "react";
import PageBreadcrumb from "../components/common/PageBreadCrumb";
import PageMeta from "../components/common/PageMeta";
import DataGrid, { type DataGridColumn } from "../components/common/DataGrid";
import { tenantApi, type Order, type Company, type Consignment, type CarrierIntegration, type CarrierIntegrationService } from "../api/client";
import Label from "../components/form/Label";

function formatDate(d: string) {
  try {
    return new Date(d).toLocaleString();
  } catch {
    return d;
  }
}

function statusBadge(status: string) {
  const s = String(status ?? "—");
  const classes =
    s === "dispatched"
      ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
      : s === "consigned"
      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400"
      : "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300";
  return <span className={"inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium " + classes}>{s}</span>;
}

type OrderWithConsignment = Order & { _consignment?: Consignment | null };

function buildColumns(): DataGridColumn<OrderWithConsignment>[] {
  return [
    { key: "company_name", label: "Company", render: (v) => (v ? String(v) : "—") },
    { key: "status", label: "Status", render: (_, row) => statusBadge(row.status) },
    { key: "order_number", label: "Order #", render: (v) => <span className="font-medium text-gray-900 dark:text-white">{String(v ?? "—")}</span> },
    { key: "email", label: "Email" },
    {
      key: "address",
      label: "Shipping address",
      render: (_, row) => {
        const a = row.address;
        if (!a || (!a.address1 && !a.city && !a.postal_code && !a.country_code)) return <span className="text-gray-400">—</span>;
        const parts = [a.address1, a.city, a.postal_code, a.country_code].filter(Boolean);
        return <span className="text-sm text-gray-700 dark:text-gray-300" title={parts.join(", ")}>{parts.join(", ") || "—"}</span>;
      },
    },
    { key: "total", label: "Total", render: (v) => (typeof v === "number" ? v.toFixed(2) : v ?? "—") },
    { key: "financial_status", label: "Financial", render: (v) => v || "—" },
    { key: "fulfillment_status", label: "Fulfillment", render: (v) => (v ? <span className={v === "fulfilled" ? "text-green-600 dark:text-green-400 font-medium" : ""}>{v}</span> : "—") },
    { key: "source", label: "Source", render: (v) => (v ? String(v).charAt(0).toUpperCase() + String(v).slice(1).toLowerCase() : "—") },
    { key: "created_at", label: "Date", render: (v) => formatDate(String(v ?? "")) },
  ];
}

const DEFAULT_STATUSES = ["imported", "consigned"];
const DISPATCHED_STATUS = "dispatched";

function hasValidAddress(order: OrderWithConsignment): boolean {
  const a = order?.address;
  if (!a) return false;
  return !!(a.address1 || a.city || a.postal_code || a.country_code);
}

export default function Orders() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [allOrders, setAllOrders] = useState<Order[]>([]);
  const [consignments, setConsignments] = useState<Consignment[]>([]);
  const [carrierIntegrations, setCarrierIntegrations] = useState<CarrierIntegration[]>([]);
  const [carrierIntegrationServices, setCarrierIntegrationServices] = useState<CarrierIntegrationService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [includeDispatched, setIncludeDispatched] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [backfillCompanyId, setBackfillCompanyId] = useState("");
  const [backfillSource, setBackfillSource] = useState("");
  const [backfilling, setBackfilling] = useState(false);
  const [backfillSuccess, setBackfillSuccess] = useState<string | null>(null);
  const [consignmentModalOpen, setConsignmentModalOpen] = useState(false);
  const [consignmentCarrierId, setConsignmentCarrierId] = useState("");
  const [consignmentServiceId, setConsignmentServiceId] = useState("");
  const [consignmentSubmitting, setConsignmentSubmitting] = useState(false);
  const [consignmentSuccessCount, setConsignmentSuccessCount] = useState<number | null>(null);

  const load = async () => {
    setError("");
    setBackfillSuccess(null);
    try {
      const [companiesRes, ordersRes, consignmentsRes, carriersRes] = await Promise.all([
        tenantApi.getCompanies(),
        tenantApi.getOrders(),
        tenantApi.getConsignments(),
        tenantApi.getCarrierIntegrations(),
      ]);
      setCompanies(Array.isArray(companiesRes?.companies) ? companiesRes.companies : []);
      setAllOrders(Array.isArray(ordersRes?.orders) ? ordersRes.orders : []);
      setConsignments(Array.isArray(consignmentsRes?.consignments) ? consignmentsRes.consignments : []);
      setCarrierIntegrations(Array.isArray(carriersRes?.carrier_integrations) ? carriersRes.carrier_integrations : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load orders");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const loadCarrierServices = async (carrierIntegrationId: string) => {
    if (!carrierIntegrationId) {
      setCarrierIntegrationServices([]);
      return;
    }
    try {
      const res = await tenantApi.getCarrierIntegrationServices({ carrier_integration_id: carrierIntegrationId });
      setCarrierIntegrationServices(res.carrier_integration_services);
    } catch {
      setCarrierIntegrationServices([]);
    }
  };

  useEffect(() => {
    if (consignmentCarrierId) loadCarrierServices(consignmentCarrierId);
    else setCarrierIntegrationServices([]);
  }, [consignmentCarrierId]);

  const ordersWithoutCompany = allOrders.filter((o) => !o.company_id);
  const unassignedSources = [...new Set(ordersWithoutCompany.map((o) => o.source).filter(Boolean))] as string[];
  const statusFilter = includeDispatched ? [...DEFAULT_STATUSES, DISPATCHED_STATUS] : DEFAULT_STATUSES;
  const ordersFilteredByCompany = companyFilter
    ? allOrders.filter((o) => o.company_id === companyFilter)
    : allOrders;
  const ordersToShow = ordersFilteredByCompany.filter((o) => statusFilter.includes(o.status));
  const columns = buildColumns();

  const handleSelectionChange = (ids: string[]) => {
    setSelectedIds(new Set(ids));
  };

  const selectedOrders = ordersToShow.filter((o) => selectedIds.has(o.id));
  const selectedWithAddress = selectedOrders.filter(hasValidAddress).map((o) => o.id);
  const selectedWithoutAddress = selectedOrders.filter((o) => !hasValidAddress(o));

  const handleCreateConsignment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consignmentCarrierId || !consignmentServiceId || selectedWithAddress.length === 0) return;
    setError("");
    setConsignmentSubmitting(true);
    try {
      const res = await tenantApi.createConsignments({
        order_ids: selectedWithAddress,
        carrier_integration_id: consignmentCarrierId,
        carrier_service_id: consignmentServiceId,
      });
      if (res.errors?.length) {
        setError(res.errors.map((x) => `${x.order_id}: ${x.error}`).join("; "));
      }
      if (res.created > 0) {
        setConsignmentSuccessCount(res.created);
        setConsignmentCarrierId("");
        setConsignmentServiceId("");
        setSelectedIds(new Set());
        await load();
        setTimeout(() => setConsignmentSuccessCount(null), 5000);
      }
      if (selectedWithoutAddress.length > 0) {
        setError(`${selectedWithoutAddress.length} order(s) have no shipping address and were excluded. Add an address to ship them.`);
      }
      setConsignmentModalOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create consignment failed");
      setConsignmentModalOpen(false);
    } finally {
      setConsignmentSubmitting(false);
    }
  };

  const openConsignmentModal = () => {
    setConsignmentCarrierId("");
    setConsignmentServiceId("");
    setConsignmentSuccessCount(null);
    setConsignmentModalOpen(true);
  };

  const handleBackfill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backfillCompanyId || !backfillSource) return;
    setError("");
    setBackfillSuccess(null);
    setBackfilling(true);
    try {
      const res = await tenantApi.backfillOrdersCompany({ company_id: backfillCompanyId, source: backfillSource });
      setBackfillSuccess(`Assigned ${res.updated} order(s) to the company.`);
      setBackfillSource("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backfill failed");
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <>
      <PageMeta title="Orders | UniSell" description="Imported orders from your integrations." />
      <PageBreadcrumb pageTitle="Orders" />
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}
        {backfillSuccess && (
          <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400">
            {backfillSuccess}
          </div>
        )}
        {consignmentSuccessCount != null && consignmentSuccessCount > 0 && (
          <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400">
            {consignmentSuccessCount} consignment(s) created. Use Print label to open each shipping label.
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4 py-2">
          <select
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white min-w-[160px]"
            aria-label="Filter by company"
          >
            <option value="">All companies</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={includeDispatched}
              onChange={(e) => setIncludeDispatched(e.target.checked)}
              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
            />
            Include dispatched
          </label>
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={openConsignmentModal}
              disabled={selectedWithAddress.length === 0}
              className="px-3 py-2 text-sm font-medium text-white rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title={selectedWithoutAddress.length > 0 ? `${selectedWithoutAddress.length} selected have no address` : ""}
            >
              Create consignment {selectedWithAddress.length > 0 ? `(${selectedWithAddress.length})` : ""}
            </button>
          </div>
        </div>
        {ordersWithoutCompany.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/80 dark:bg-amber-900/20 dark:border-amber-800 p-3">
            <p className="text-sm text-amber-800 dark:text-amber-300 mb-3">
              <strong>{ordersWithoutCompany.length}</strong> order{ordersWithoutCompany.length !== 1 ? "s" : ""} without company — assign to show in company filter.
            </p>
            <form onSubmit={handleBackfill} className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-amber-900 dark:text-amber-200 mb-1">Company</label>
                <select
                  value={backfillCompanyId}
                  onChange={(e) => setBackfillCompanyId(e.target.value)}
                  required
                  className="px-3 py-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white min-w-[180px]"
                >
                  <option value="">Select company</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-amber-900 dark:text-amber-200 mb-1">Source (e.g. shopify)</label>
                <select
                  value={backfillSource}
                  onChange={(e) => setBackfillSource(e.target.value)}
                  required
                  className="px-3 py-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white min-w-[140px]"
                >
                  <option value="">Select source</option>
                  {unassignedSources.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                disabled={backfilling}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50"
              >
                {backfilling ? "Assigning…" : "Assign to company"}
              </button>
            </form>
          </div>
        )}
        <DataGrid
          columns={columns}
          data={ordersToShow}
          keyExtractor={(o) => o.id}
          emptyMessage={companyFilter ? "No orders for this company." : "No orders yet. Add an active integration (e.g. Shopify) and wait for the next import."}
          loading={loading}
          selectable
          selectedIds={Array.from(selectedIds)}
          onSelectionChange={handleSelectionChange}
        />
      </div>

      {consignmentModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => !consignmentSubmitting && setConsignmentModalOpen(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Create consignment (real-time label)</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Uses: order shipping address (destination), company address (origin), carrier credentials. One label per selected order.
            </p>
            <form onSubmit={handleCreateConsignment} className="space-y-4">
              <div>
                <Label htmlFor="carrier">Carrier integration</Label>
                <select
                  id="carrier"
                  value={consignmentCarrierId}
                  onChange={(e) => {
                    setConsignmentCarrierId(e.target.value);
                    setConsignmentServiceId("");
                  }}
                  required
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                >
                  <option value="">Select carrier</option>
                  {carrierIntegrations.map((ci) => (
                    <option key={ci.id} value={ci.id}>
                      {ci.carrier_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="service">Carrier service</Label>
                <select
                  id="service"
                  value={consignmentServiceId}
                  onChange={(e) => setConsignmentServiceId(e.target.value)}
                  required
                  disabled={!consignmentCarrierId}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-50"
                >
                  <option value="">Select service</option>
                  {carrierIntegrationServices.map((s) => (
                    <option key={s.id} value={s.carrier_service_id}>
                      {s.carrier_service_name} ({s.carrier_service_code})
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {selectedWithAddress.length} order(s) with shipping address will get a label. {selectedWithoutAddress.length > 0 && `${selectedWithoutAddress.length} selected have no address and were excluded.`}
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => !consignmentSubmitting && setConsignmentModalOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={consignmentSubmitting || !consignmentCarrierId || !consignmentServiceId || selectedWithAddress.length === 0}
                  className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 min-w-[120px]"
                >
                  {consignmentSubmitting ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
