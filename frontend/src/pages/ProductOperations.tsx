import { useEffect, useState, useCallback } from "react";
import PageBreadcrumb from "../components/common/PageBreadCrumb";
import PageMeta from "../components/common/PageMeta";
import DataGrid, { type DataGridColumn } from "../components/common/DataGrid";
import { tenantApi, type Product } from "../api/client";
import Label from "../components/form/Label";
import Input from "../components/form/input/InputField";
import TextArea from "../components/form/input/TextArea";
import Radio from "../components/form/input/Radio";
import Checkbox from "../components/form/input/Checkbox";

const SIZE_OPTIONS = ["XS", "S", "M", "L", "XL"];

const SHIPPING_COUNTRIES = [
  { value: "", label: "Select country/region" },
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
  { value: "GB", label: "United Kingdom" },
  { value: "AU", label: "Australia" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "IN", label: "India" },
  { value: "PK", label: "Pakistan" },
  { value: "AE", label: "United Arab Emirates" },
  { value: "SG", label: "Singapore" },
  { value: "MY", label: "Malaysia" },
  { value: "JP", label: "Japan" },
  { value: "CN", label: "China" },
  { value: "EU", label: "European Union (general)" },
];

function emptyForm() {
  return {
    title: "",
    page_title: "",
    handle: "",
    description: "",
    sku: "",
    product_type: "",
    price: "",
    price_old: "",
    coupon: "",
    status: "published" as "published" | "scheduled" | "hidden",
    sizes: [] as string[],
    shipping_country: "",
    images: [] as string[],
  };
}

export default function ProductOperations() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const res = await tenantApi.getProducts();
      setProducts(Array.isArray(res?.products) ? res.products : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load products");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setFormVisible(true);
  };

  const openEdit = (p: Product) => {
    setEditing(p);
    setForm({
      title: p.title ?? "",
      page_title: p.page_title ?? "",
      handle: p.handle ?? "",
      description: p.description ?? "",
      sku: p.sku ?? "",
      product_type: p.product_type ?? "",
      price: p.price != null ? String(p.price) : "",
      price_old: p.price_old != null ? String(p.price_old) : "",
      coupon: p.coupon ?? "",
      status: (p.status === "scheduled" || p.status === "hidden" ? p.status : "published") as "published" | "scheduled" | "hidden",
      sizes: Array.isArray(p.sizes) ? p.sizes : [],
      shipping_country: p.shipping_country ?? "",
      images: Array.isArray(p.images) ? p.images : [],
    });
    setFormVisible(true);
  };

  const closeForm = () => {
    setFormVisible(false);
    setEditing(null);
  };

  const toggleSize = (size: string) => {
    setForm((prev) => ({
      ...prev,
      sizes: prev.sizes.includes(size)
        ? prev.sizes.filter((s) => s !== size)
        : [...prev.sizes, size],
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = form.title.trim();
    if (!title) {
      setError("Product name is required.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const price = form.price.trim() === "" ? undefined : Number(form.price);
      const price_old = form.price_old.trim() === "" ? undefined : Number(form.price_old);
      if (editing) {
        await tenantApi.updateProduct(editing.id, {
          title,
          page_title: form.page_title.trim() || undefined,
          handle: form.handle.trim() || undefined,
          description: form.description.trim() || undefined,
          sku: form.sku.trim() || undefined,
          product_type: form.product_type.trim() || undefined,
          price: price != null && !Number.isNaN(price) ? price : undefined,
          price_old: price_old != null && !Number.isNaN(price_old) ? price_old : undefined,
          coupon: form.coupon.trim() || undefined,
          status: form.status,
          sizes: form.sizes.length ? form.sizes : undefined,
          shipping_country: form.shipping_country || undefined,
          images: form.images.length ? form.images : undefined,
        });
      } else {
        await tenantApi.createProduct({
          title,
          page_title: form.page_title.trim() || undefined,
          handle: form.handle.trim() || undefined,
          description: form.description.trim() || undefined,
          sku: form.sku.trim() || undefined,
          product_type: form.product_type.trim() || undefined,
          price: price != null && !Number.isNaN(price) ? price : undefined,
          price_old: price_old != null && !Number.isNaN(price_old) ? price_old : undefined,
          coupon: form.coupon.trim() || undefined,
          status: form.status,
          sizes: form.sizes.length ? form.sizes : undefined,
          shipping_country: form.shipping_country || undefined,
          images: form.images.length ? form.images : undefined,
          source: "local",
        });
      }
      await load();
      closeForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (p: Product) => {
    if (!window.confirm(`Delete product "${p.title}"?`)) return;
    setError("");
    try {
      await tenantApi.deleteProduct(p.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    }
  };

  const columns: DataGridColumn<Product>[] = [
    { key: "title", label: "Product", render: (v) => String(v || "—") },
    { key: "sku", label: "SKU", render: (v) => String(v || "—") },
    { key: "product_type", label: "Type", render: (v) => String(v || "—") },
    {
      key: "price",
      label: "Price",
      align: "right",
      render: (v, row) => {
        const p = typeof row.price === "number" ? row.price : null;
        const old = typeof row.price_old === "number" ? row.price_old : null;
        if (p != null && old != null) return <span>{p.toFixed(2)} <span className="text-gray-400 line-through text-xs">{old.toFixed(2)}</span></span>;
        if (p != null) return p.toFixed(2);
        return "—";
      },
    },
    { key: "status", label: "Status", render: (v) => String(v || "active") },
    {
      key: "source",
      label: "Source",
      render: (v) => (v ? String(v).charAt(0).toUpperCase() + String(v).slice(1).toLowerCase() : "—"),
    },
    {
      key: "id",
      label: "Actions",
      render: (_, row) => (
        <span className="inline-flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => openEdit(row)}
            className="font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => handleDelete(row)}
            className="font-medium text-rose-500 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-300"
          >
            Delete
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="min-h-screen">
      <PageMeta
        title="Product operations | UniSell"
        description="Add, edit and delete products in your catalog."
      />
      <PageBreadcrumb pageTitle="Product operations" />

      <div className="space-y-6">
        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
            {error}
          </div>
        )}

        {formVisible && (
          <div className="overflow-hidden rounded-2xl border border-gray-200/90 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900/50">
            <div className="border-b border-gray-100 bg-gray-50/80 px-6 py-4 dark:border-gray-800 dark:bg-gray-800/50">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
                  {editing ? "Edit product" : "Add product"}
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={closeForm}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    form="product-form"
                    disabled={saving}
                    className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-sky-700 disabled:opacity-60 dark:bg-sky-500 dark:hover:bg-sky-600"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            </div>

            <form id="product-form" onSubmit={handleSave} className="p-6">
              <div className="grid gap-8 lg:grid-cols-2">
                {/* Left column */}
                <div className="space-y-6">
                  <section className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                    <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Pricing
                    </h3>
                    <div className="space-y-4">
                      <div>
                        <Label>Product price (current)</Label>
                        <Input
                          type="text"
                          inputMode="decimal"
                          value={form.price}
                          onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                          placeholder="e.g. 29.99"
                          className="mt-1.5"
                        />
                      </div>
                      <div>
                        <Label>Product price (original / compare at)</Label>
                        <Input
                          type="text"
                          inputMode="decimal"
                          value={form.price_old}
                          onChange={(e) => setForm((f) => ({ ...f, price_old: e.target.value }))}
                          placeholder="e.g. 39.99"
                          className="mt-1.5"
                        />
                      </div>
                      <div>
                        <Label>Product coupon / discount code</Label>
                        <Input
                          value={form.coupon}
                          onChange={(e) => setForm((f) => ({ ...f, coupon: e.target.value }))}
                          placeholder="e.g. SAVE10"
                          className="mt-1.5"
                        />
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                    <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Visibility
                    </h3>
                    <div className="flex flex-wrap gap-6">
                      <Radio
                        id="vis-published"
                        name="visibility"
                        value="published"
                        checked={form.status === "published"}
                        label="Published"
                        onChange={(v) => setForm((f) => ({ ...f, status: v as "published" }))}
                      />
                      <Radio
                        id="vis-scheduled"
                        name="visibility"
                        value="scheduled"
                        checked={form.status === "scheduled"}
                        label="Scheduled"
                        onChange={(v) => setForm((f) => ({ ...f, status: v as "scheduled" }))}
                      />
                      <Radio
                        id="vis-hidden"
                        name="visibility"
                        value="hidden"
                        checked={form.status === "hidden"}
                        label="Hidden"
                        onChange={(v) => setForm((f) => ({ ...f, status: v as "hidden" }))}
                      />
                    </div>
                  </section>

                  <section className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                    <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Size
                    </h3>
                    <div className="flex flex-wrap gap-4">
                      {SIZE_OPTIONS.map((size) => (
                        <Checkbox
                          key={size}
                          label={size}
                          checked={form.sizes.includes(size)}
                          onChange={() => toggleSize(size)}
                        />
                      ))}
                    </div>
                  </section>
                </div>

                {/* Right column */}
                <div className="space-y-6">
                  <section className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                    <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Basic information
                    </h3>
                    <div className="space-y-4">
                      <div>
                        <Label>Name</Label>
                        <Input
                          value={form.title}
                          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                          placeholder="e.g. Classic Cotton T-Shirt"
                          className="mt-1.5"
                          required
                        />
                      </div>
                      <div>
                        <Label>Page title (SEO)</Label>
                        <Input
                          value={form.page_title}
                          onChange={(e) => setForm((f) => ({ ...f, page_title: e.target.value }))}
                          placeholder="e.g. Buy Classic Cotton T-Shirt Online"
                          className="mt-1.5"
                        />
                      </div>
                      <div>
                        <Label>Product URL handle (slug)</Label>
                        <Input
                          value={form.handle}
                          onChange={(e) => setForm((f) => ({ ...f, handle: e.target.value }))}
                          placeholder="e.g. classic-cotton-tshirt"
                          className="mt-1.5"
                        />
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          Used in product page URL. Leave blank to auto-generate from name.
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>SKU</Label>
                          <Input
                            value={form.sku}
                            onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
                            placeholder="e.g. TSH-001"
                            className="mt-1.5"
                          />
                        </div>
                        <div>
                          <Label>Product type</Label>
                          <Input
                            value={form.product_type}
                            onChange={(e) => setForm((f) => ({ ...f, product_type: e.target.value }))}
                            placeholder="e.g. T-Shirt"
                            className="mt-1.5"
                          />
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                    <Label>Product description</Label>
                    <TextArea
                      value={form.description}
                      onChange={(v) => setForm((f) => ({ ...f, description: v }))}
                      placeholder="Enter product description here. You can include features, materials, and care instructions."
                      rows={5}
                      className="mt-1.5"
                    />
                  </section>

                  <section className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                    <Label>Shipping country / region</Label>
                    <select
                      value={form.shipping_country}
                      onChange={(e) => setForm((f) => ({ ...f, shipping_country: e.target.value }))}
                      className="mt-1.5 h-11 w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 pr-10 text-sm text-gray-800 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:focus:border-sky-500"
                    >
                      {SHIPPING_COUNTRIES.map((opt) => (
                        <option key={opt.value || "empty"} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </section>

                  <section className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                    <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Product images
                    </h3>
                    <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                      Add image URLs (one per line) or leave empty. Image upload can be added later.
                    </p>
                    <TextArea
                      value={form.images.join("\n")}
                      onChange={(v) =>
                        setForm((f) => ({
                          ...f,
                          images: v
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        }))
                      }
                      placeholder={"https://example.com/image1.jpg\nhttps://example.com/image2.jpg"}
                      rows={3}
                      className="font-mono text-xs"
                    />
                  </section>
                </div>
              </div>
            </form>
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-sky-700 dark:bg-sky-500 dark:hover:bg-sky-600"
          >
            {formVisible ? "Add another product" : "Add product"}
          </button>
        </div>

        <DataGrid
          columns={columns}
          data={products}
          keyExtractor={(p) => p.id}
          emptyMessage="No products yet. Use Add product to create local products, or let your store integrations sync them."
          loading={loading}
        />
      </div>
    </div>
  );
}
