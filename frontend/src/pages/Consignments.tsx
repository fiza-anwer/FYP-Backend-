import { useState, useEffect } from "react";
import PageBreadcrumb from "../components/common/PageBreadCrumb";
import PageMeta from "../components/common/PageMeta";
import DataGrid, { type DataGridColumn } from "../components/common/DataGrid";
import { tenantApi, openConsignmentLabel, type Order, type Consignment } from "../api/client";

function formatDate(d: string) {
  try {
    return new Date(d).toLocaleString();
  } catch {
    return d;
  }
}

function hasValidAddress(order: Order): boolean {
  const a = order?.address;
  if (!a) return false;
  return !!(a.address1 || a.city || a.postal_code || a.country_code);
}

type ConsignmentRow = Consignment & { _order?: Order | null };

export default function Consignments() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [consignments, setConsignments] = useState<Consignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [dispatchSuccessCount, setDispatchSuccessCount] = useState<number | null>(null);

  const load = async () => {
    setError("");
    try {
      const [ordersRes, consignmentsRes] = await Promise.all([
        tenantApi.getOrders(),
        tenantApi.getConsignments(),
      ]);
      setOrders(Array.isArray(ordersRes?.orders) ? ordersRes.orders : []);
      setConsignments(Array.isArray(consignmentsRes?.consignments) ? consignmentsRes.consignments : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load consignments");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const ordersById: Record<string, Order> = {};
  orders.forEach((o) => {
    ordersById[o.id] = o;
  });

  const rows: ConsignmentRow[] = consignments.map((c) => ({
    ...c,
    _order: ordersById[c.order_id] ?? null,
  }));

  const columns: DataGridColumn<ConsignmentRow>[] = [
    {
      key: "order_number",
      label: "Order #",
      render: (_, row) => (
        <span className="font-medium text-gray-900 dark:text-white">
          {row._order?.order_number ?? row.order_id ?? "—"}
        </span>
      ),
    },
    {
      key: "company",
      label: "Company",
      render: (_, row) => (row._order?.company_name ? String(row._order.company_name) : "—"),
    },
    {
      key: "address",
      label: "Shipping address",
      render: (_, row) => {
        const a = row._order?.address;
        if (!a || !hasValidAddress(row._order!)) {
          return <span className="text-amber-600 dark:text-amber-400">No address — cannot ship</span>;
        }
        const parts = [a.address1, a.city, a.postal_code, a.country_code].filter(Boolean);
        return (
          <span className="text-sm text-gray-700 dark:text-gray-300" title={parts.join(", ")}>
            {parts.join(", ") || "—"}
          </span>
        );
      },
    },
    { key: "carrier_name", label: "Carrier", render: (v) => v ?? "—" },
    { key: "tracking_number", label: "Tracking", render: (v) => (v ? String(v) : "—") },
    {
      key: "status",
      label: "Order status",
      render: (_, row) => {
        const s = row._order?.status ?? "—";
        const isDispatched = s === "dispatched";
        return (
          <span
            className={
              isDispatched
                ? "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                : "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400"
            }
          >
            {s}
          </span>
        );
      },
    },
    {
      key: "actions",
      label: "Label / Track / Dispatch",
      render: (_, row) => {
        const order = row._order;
        const hasAddress = order && hasValidAddress(order);
        const isDispatched = order?.status === "dispatched";
        const trackUrl = row.tracking_url?.trim() || null;

        return (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            {hasAddress ? (
              <button
                type="button"
                onClick={async () => {
                  const w = window.open("", "_blank");
                  try {
                    await openConsignmentLabel(row.id, w ?? undefined);
                  } catch (e) {
                    if (w && !w.closed) w.close();
                    alert((e instanceof Error ? e.message : "Failed to open label") + "\n\nCheck that the consignment has a label and you are logged in.");
                  }
                }}
                className="text-brand-600 hover:underline text-sm bg-transparent border-none cursor-pointer p-0 font-inherit"
                title="Open shipping label to print"
              >
                Print label
              </button>
            ) : (
              <span className="text-gray-400 text-sm" title="Add shipping address to order to print label">
                Print label
              </span>
            )}
            {trackUrl && isDispatched && (
              <>
                <span className="text-gray-400">|</span>
                <a
                  href={trackUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-600 hover:underline text-sm"
                  title="Track delivery"
                >
                  Track
                </a>
              </>
            )}
          </span>
        );
      },
    },
    { key: "created_at", label: "Date", render: (v) => formatDate(String(v ?? "")) },
  ];

  const selectedConsignmentIds = Array.from(selectedIds);
  const orderIdsFromSelection: string[] = selectedConsignmentIds
    .map((cid) => consignments.find((c) => c.id === cid)?.order_id)
    .filter((id): id is string => Boolean(id));
  const selectedWithAddress = orderIdsFromSelection.filter((orderId) => {
    const order = ordersById[orderId];
    return order && hasValidAddress(order) && order.status !== "dispatched";
  });

  const handleDispatch = async () => {
    if (selectedWithAddress.length === 0) return;
    setError("");
    setDispatchLoading(true);
    try {
      const res = await tenantApi.dispatchOrders({ order_ids: selectedWithAddress });
      if (res.errors?.length) {
        setError(res.errors.map((x) => `${x.order_id}: ${x.error}`).join("; "));
      }
      if (res.dispatched > 0) {
        setDispatchSuccessCount(res.dispatched);
        setSelectedIds(new Set());
        await load();
        setTimeout(() => setDispatchSuccessCount(null), 5000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dispatch failed");
    } finally {
      setDispatchLoading(false);
    }
  };

  return (
    <>
      <PageMeta title="Consignments | UniSell" description="Consigned orders: print labels, dispatch, and track." />
      <PageBreadcrumb pageTitle="Consignments" />
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}
        {dispatchSuccessCount != null && dispatchSuccessCount > 0 && (
          <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400">
            {dispatchSuccessCount} order(s) dispatched. Use Track to follow delivery.
          </div>
        )}
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Orders that already have a consignment. Print labels and dispatch only for orders with a shipping address. Track after dispatch.
        </p>
        <div className="flex flex-wrap items-center gap-4 py-2">
          <button
            type="button"
            onClick={handleDispatch}
            disabled={selectedWithAddress.length === 0 || dispatchLoading}
            className="px-3 py-2 text-sm font-medium text-white rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {dispatchLoading ? "Dispatching…" : `Dispatch ${selectedWithAddress.length > 0 ? `(${selectedWithAddress.length})` : ""}`}
          </button>
          {selectedIds.size > 0 && selectedWithAddress.length < selectedIds.size && (
            <span className="text-sm text-amber-700 dark:text-amber-400">
              {selectedIds.size - selectedWithAddress.length} selected have no address or are already dispatched — excluded.
            </span>
          )}
        </div>
        <DataGrid
          columns={columns}
          data={rows}
          keyExtractor={(r) => r.id}
          emptyMessage="No consignments yet. Create consignments from the Orders page."
          loading={loading}
          selectable
          selectedIds={Array.from(selectedIds)}
          onSelectionChange={(ids) => setSelectedIds(new Set(ids))}
        />
      </div>
    </>
  );
}
