import { useState, useEffect, useRef } from "react";
import PageBreadcrumb from "../components/common/PageBreadCrumb";
import PageMeta from "../components/common/PageMeta";
import DataGrid, { type DataGridColumn } from "../components/common/DataGrid";
import { tenantApi, type Company } from "../api/client";
import Label from "../components/form/Label";
import Input from "../components/form/input/InputField";

export default function Companies() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [formName, setFormName] = useState("");
  const [formAddress1, setFormAddress1] = useState("");
  const [formCity, setFormCity] = useState("");
  const [formPostalCode, setFormPostalCode] = useState("");
  const [formCountryCode, setFormCountryCode] = useState("");
  const [saving, setSaving] = useState(false);
  const formContainerRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    setError("");
    try {
      const res = await tenantApi.getCompanies();
      setCompanies(Array.isArray(res?.companies) ? res.companies : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setFormName("");
    setFormAddress1("");
    setFormCity("");
    setFormPostalCode("");
    setFormCountryCode("");
    setFormVisible(true);
  };

  const openEdit = (c: Company) => {
    setEditing(c);
    setFormName(c.name);
    const a = c.address;
    setFormAddress1(a?.address1 ?? "");
    setFormCity(a?.city ?? "");
    setFormPostalCode(a?.postal_code ?? "");
    setFormCountryCode(a?.country_code ?? "");
    setFormVisible(true);
  };

  const closeForm = () => {
    setFormVisible(false);
    setEditing(null);
  };

  useEffect(() => {
    if (formVisible && formContainerRef.current) {
      formContainerRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [formVisible]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = formName.trim();
    if (!name) {
      setError("Company name is required");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const body = {
        name,
        address1: formAddress1.trim() || undefined,
        city: formCity.trim() || undefined,
        postal_code: formPostalCode.trim() || undefined,
        country_code: formCountryCode.trim().substring(0, 2).toUpperCase() || undefined,
      };
      if (editing) {
        await tenantApi.updateCompany(editing.id, body);
      } else {
        await tenantApi.createCompany(body);
      }
      closeForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (c: Company) => {
    if (!confirm(`Delete company "${c.name}"?`)) return;
    setError("");
    try {
      await tenantApi.deleteCompany(c.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const columns: DataGridColumn<Company>[] = [
    {
      key: "name",
      label: "Company",
      render: (v) => <span className="font-medium text-gray-900 dark:text-white">{String(v ?? "—")}</span>,
    },
    {
      key: "address",
      label: "Address",
      render: (_, row) => {
        const a = row.address;
        if (!a || (!a.city && !a.country_code && !a.address1)) return <span className="text-gray-400">—</span>;
        const parts = [a.address1, a.city, a.postal_code, a.country_code].filter(Boolean);
        return <span className="text-sm text-gray-600 dark:text-gray-400">{parts.join(", ") || "—"}</span>;
      },
    },
    {
      key: "id",
      label: "Actions",
      align: "right",
      render: (_, row) => (
        <span className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => openEdit(row)}
            className="text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => handleDelete(row)}
            className="text-sm font-medium text-rose-500 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-300"
          >
            Delete
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageMeta title="Companies | UniSell" description="Manage companies." />
      <PageBreadcrumb pageTitle="Companies" />
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}

        {formVisible ? (
          <div
            ref={formContainerRef}
            className="overflow-hidden rounded-2xl border border-gray-200/90 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900/50"
          >
            <div className="border-b border-gray-100 px-6 py-4 dark:border-gray-800">
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">{editing ? "Edit company" : "Add company"}</h2>
            </div>
            <form onSubmit={handleSave} className="p-6">
              <div className="space-y-5 max-w-2xl">
                <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                  <Label>Company name</Label>
                  <Input
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="e.g. Acme Inc"
                    className="mt-1.5"
                  />
                </div>
                <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                  <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">Address (shipper/origin for consignments)</p>
                  <div className="space-y-4">
                    <div>
                      <Label>Address (street)</Label>
                      <Input value={formAddress1} onChange={(e) => setFormAddress1(e.target.value)} placeholder="e.g. 123 High Street" className="mt-1.5" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>City</Label>
                        <Input value={formCity} onChange={(e) => setFormCity(e.target.value)} placeholder="e.g. London" className="mt-1.5" />
                      </div>
                      <div>
                        <Label>Postal code</Label>
                        <Input value={formPostalCode} onChange={(e) => setFormPostalCode(e.target.value)} placeholder="e.g. SW1A 1AA" className="mt-1.5" />
                      </div>
                    </div>
                    <div>
                      <Label>Country code</Label>
                      <Input value={formCountryCode} onChange={(e) => setFormCountryCode(e.target.value)} placeholder="e.g. GB" className="mt-1.5" maxLength={2} />
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-8 flex justify-end gap-2 border-t border-gray-200 pt-6 dark:border-gray-700">
                <button type="button" onClick={closeForm} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60 dark:bg-indigo-500 dark:hover:bg-indigo-600">
                  {saving ? "Saving…" : editing ? "Update" : "Create"}
                </button>
              </div>
            </form>
          </div>
        ) : (
          <>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={openCreate}
                className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
              >
                Add company
              </button>
            </div>
            <DataGrid
              columns={columns}
              data={companies}
              keyExtractor={(c) => c.id}
              emptyMessage="No companies yet. Click Add company to create one."
              loading={loading}
            />
          </>
        )}
      </div>
    </div>
  );
}
