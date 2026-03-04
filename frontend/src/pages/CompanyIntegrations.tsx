import { useState, useEffect, useRef } from "react";
import PageBreadcrumb from "../components/common/PageBreadCrumb";
import PageMeta from "../components/common/PageMeta";
import DataGrid, { type DataGridColumn } from "../components/common/DataGrid";
import { tenantApi, type CompanyIntegration, type Company, type IntegrationCredentialSchema } from "../api/client";
import Label from "../components/form/Label";
import Input from "../components/form/input/InputField";
import Checkbox from "../components/form/input/Checkbox";

export default function CompanyIntegrations() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [integrations, setIntegrations] = useState<Array<{ id: string; name: string; slug: string; credentials_schema: IntegrationCredentialSchema[] }>>([]);
  const [companyIntegrations, setCompanyIntegrations] = useState<CompanyIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<CompanyIntegration | null>(null);
  const [formCompanyId, setFormCompanyId] = useState("");
  const [formIntegrationId, setFormIntegrationId] = useState("");
  const [formCredentials, setFormCredentials] = useState<Record<string, string>>({});
  const [formActive, setFormActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const formContainerRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    setError("");
    try {
      const [companiesRes, intRes, ciRes] = await Promise.all([
        tenantApi.getCompanies(),
        tenantApi.getIntegrations(),
        tenantApi.getCompanyIntegrations(),
      ]);
      setCompanies(Array.isArray(companiesRes?.companies) ? companiesRes.companies : []);
      setIntegrations(Array.isArray(intRes?.integrations) ? intRes.integrations : []);
      setCompanyIntegrations(Array.isArray(ciRes?.company_integrations) ? ciRes.company_integrations : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selectedSchema = integrations.find((i) => i.id === formIntegrationId)?.credentials_schema || [];

  const openCreate = () => {
    setEditing(null);
    setFormCompanyId("");
    setFormIntegrationId("");
    setFormCredentials({});
    setFormActive(true);
    setFormVisible(true);
  };

  const openEdit = (ci: CompanyIntegration) => {
    setEditing(ci);
    setFormCompanyId(ci.company_id || "");
    setFormIntegrationId(ci.integration_id);
    setFormCredentials(ci.credentials || {});
    setFormActive(ci.status === 1);
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
    setError("");
    setSaving(true);
    try {
      if (editing) {
        await tenantApi.updateCompanyIntegration(editing.id, {
          company_id: formCompanyId || undefined,
          credentials: formCredentials,
          status: formActive ? 1 : 0,
        });
      } else {
        if (!formCompanyId) {
          setError("Select a company");
          setSaving(false);
          return;
        }
        if (!formIntegrationId) {
          setError("Select an integration");
          setSaving(false);
          return;
        }
        await tenantApi.createCompanyIntegration({
          company_id: formCompanyId,
          integration_id: formIntegrationId,
          credentials: formCredentials,
          status: formActive ? 1 : 0,
        });
      }
      closeForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (ci: CompanyIntegration) => {
    if (!confirm("Delete " + ci.integration_name + " integration?")) return;
    setError("");
    try {
      await tenantApi.deleteCompanyIntegration(ci.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const integrationColumns: DataGridColumn<CompanyIntegration>[] = [
    {
      key: "company_name",
      label: "Company",
      render: (v) => <span className="font-medium text-gray-900 dark:text-white">{String(v ?? "—")}</span>,
    },
    {
      key: "integration_name",
      label: "Integration",
      render: (v) => <span className="text-gray-700 dark:text-gray-300">{String(v ?? "—")}</span>,
    },
    {
      key: "status",
      label: "Status",
      render: (_, row) => (
        <span
          className={
            "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium " +
            (row.status === 1
              ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
              : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-400")
          }
        >
          {row.status === 1 ? "Active" : "Inactive"}
        </span>
      ),
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
      <PageMeta title="Company Integrations | UniSell" description="Manage your company integrations." />
      <PageBreadcrumb pageTitle="Company Integrations" />
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
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">{editing ? "Edit integration" : "Add integration"}</h2>
            </div>
            <form onSubmit={handleSave} className="p-6">
              <div className="space-y-5 max-w-2xl">
                <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                  <Label>Company</Label>
                  <select
                    value={formCompanyId}
                    onChange={(e) => setFormCompanyId(e.target.value)}
                    disabled={!!editing}
                    className="mt-1.5 h-11 w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  >
                    <option value="">Select company</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  {!editing && companies.length === 0 && (
                    <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">Create a company first from the Companies page.</p>
                  )}
                </div>
                <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                  <Label>Integration</Label>
                  <select
                    value={formIntegrationId}
                    onChange={(e) => { setFormIntegrationId(e.target.value); setFormCredentials({}); }}
                    disabled={!!editing}
                    className="mt-1.5 h-11 w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  >
                    <option value="">Select integration</option>
                    {integrations.map((i) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </select>
                  {!editing && integrations.length === 0 && (
                    <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">No integrations available. Run backend migration then refresh.</p>
                  )}
                </div>
                {selectedSchema.length > 0 && (
                  <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                    <Label>Credentials</Label>
                    <div className="mt-3 space-y-3">
                      {selectedSchema.map((field) => (
                        <div key={field.key}>
                          <Label className="text-sm">{field.label}</Label>
                          <Input
                            type={field.type === "password" ? "password" : "text"}
                            placeholder={field.placeholder}
                            value={formCredentials[field.key] ?? ""}
                            onChange={(e) => setFormCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))}
                            className="mt-1.5"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2 rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                  <Checkbox checked={formActive} onChange={setFormActive} />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Active (order import will run for this integration)</span>
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
                Add integration
              </button>
            </div>
            <DataGrid
              columns={integrationColumns}
              data={companyIntegrations}
              keyExtractor={(ci) => ci.id}
              emptyMessage="No integrations yet. Click Add integration to connect a store."
              loading={loading}
            />
          </>
        )}
      </div>
    </div>
  );
}
