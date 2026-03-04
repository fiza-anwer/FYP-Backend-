import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { Link } from "react-router";
import PageBreadcrumb from "../components/common/PageBreadCrumb";
import PageMeta from "../components/common/PageMeta";
import DataGrid, { type DataGridColumn } from "../components/common/DataGrid";
import { tenantApi, type Product, type ProductVariant, type Company } from "../api/client";
import Input from "../components/form/input/InputField";
import Label from "../components/form/Label";
import TextArea from "../components/form/input/TextArea";
import Radio from "../components/form/input/Radio";
import Checkbox from "../components/form/input/Checkbox";
import { Dropdown } from "../components/ui/dropdown/Dropdown";
import { DropdownItem } from "../components/ui/dropdown/DropdownItem";
import { HorizontaLDots, PlusIcon, TrashBinIcon } from "../icons";

type SortKey = "name_asc" | "name_desc" | "price_asc" | "price_desc" | "newest" | "oldest";

/** One row in the list = one variant (or the product when it has no variants). */
type ProductListRow = {
  product: Product;
  variant: ProductVariant | null;
  variantIndex: number;
};

function getRowId(row: ProductListRow): string {
  return `${row.product.id}-${row.variantIndex}-${row.variant?.id ?? "0"}`;
}

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
    company_id: "" as string,
    variants: [] as ProductVariant[],
  };
}

export default function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  /** When set, we're editing only this variant index of the product (from list row). */
  const [editingVariantIndex, setEditingVariantIndex] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [actionsOpenId, setActionsOpenId] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const formContainerRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    tenantApi.getCompanies().then((res) => setCompanies(res.companies || [])).catch(() => setCompanies([]));
  }, []);

  useEffect(() => {
    if (formVisible && formContainerRef.current) {
      formContainerRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [formVisible]);

  const openCreate = () => {
    setEditing(null);
    setEditingVariantIndex(null);
    setSyncWarning(null);
    setForm(emptyForm());
    setFormVisible(true);
  };

  /** Open edit form. When variantIndex is set, only that variant is shown and saved. */
  const openEdit = (p: Product, variantIndex?: number) => {
    setEditing(p);
    setEditingVariantIndex(variantIndex ?? null);
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const singleVariant =
      variantIndex != null && variants[variantIndex] != null ? [variants[variantIndex]] : variants;
    const variantForPrice =
      variantIndex != null && variants[variantIndex] != null
        ? variants[variantIndex]
        : null;
    const displayPrice = variantForPrice?.price ?? p.price;
    const displayPriceOld = p.price_old;
    setForm({
      title: p.title ?? "",
      page_title: p.page_title ?? "",
      handle: p.handle ?? "",
      description: p.description ?? "",
      sku: p.sku ?? "",
      product_type: p.product_type ?? "",
      price: displayPrice != null ? String(displayPrice) : "",
      price_old: displayPriceOld != null ? String(displayPriceOld) : "",
      coupon: p.coupon ?? "",
      status: (p.status === "scheduled" || p.status === "hidden" ? p.status : "published") as "published" | "scheduled" | "hidden",
      sizes: Array.isArray(p.sizes) ? p.sizes : [],
      shipping_country: p.shipping_country ?? "",
      images: Array.isArray(p.images) ? p.images : [],
      company_id: p.company_id ?? "",
      variants: singleVariant,
    });
    setFormVisible(true);
    setActionsOpenId(null);
  };

  const closeForm = () => {
    setFormVisible(false);
    setEditing(null);
    setEditingVariantIndex(null);
  };

  const toggleSize = (size: string) => {
    setForm((prev) => ({
      ...prev,
      sizes: prev.sizes.includes(size)
        ? prev.sizes.filter((s) => s !== size)
        : [...prev.sizes, size],
    }));
  };

  const addVariant = () => {
    setForm((prev) => ({
      ...prev,
      variants: [...prev.variants, { sku: "", option1: "", price: undefined }],
    }));
  };

  const updateVariant = (index: number, field: keyof ProductVariant, value: string | number | undefined) => {
    setForm((prev) => {
      const next = [...prev.variants];
      next[index] = { ...next[index], [field]: value };
      return { ...prev, variants: next };
    });
  };

  const removeVariant = (index: number) => {
    setForm((prev) => ({
      ...prev,
      variants: prev.variants.filter((_, i) => i !== index),
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
      const variants = form.variants.map((v) => ({
        ...v,
        price: v.price != null ? v.price : undefined,
      }));
      if (editing) {
        let variantsToSend: typeof variants | undefined = variants.length ? variants : undefined;
        if (editingVariantIndex != null && editing.variants?.length) {
          const merged = editing.variants.map((v) => ({ ...v }));
          const updated = variants[0];
          if (updated) {
            merged[editingVariantIndex] = { ...merged[editingVariantIndex], ...updated };
            if (price != null && !Number.isNaN(price)) merged[editingVariantIndex].price = price;
            variantsToSend = merged;
          }
        }
        const updatePayload = {
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
          variants: variantsToSend,
        };
        const data = await tenantApi.updateProduct(editing.id, updatePayload) as Product & { sync_warning?: string };
        if (data?.sync_warning) setSyncWarning(data.sync_warning);
        else setSyncWarning(null);
      } else {
        await tenantApi.createProduct({
          title,
          company_id: form.company_id.trim() || undefined,
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
          variants: variants.length ? variants : undefined,
        });
      }
      await load();
      closeForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
      setSyncWarning(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (p: Product) => {
    setActionsOpenId(null);
    if (!window.confirm(`Delete product "${p.title}"?`)) return;
    setError("");
    try {
      await tenantApi.deleteProduct(p.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    }
  };

  /** One row per variant (or one row per product when no variants). */
  const flattenedRows = useMemo(() => {
    const rows: ProductListRow[] = [];
    for (const product of products) {
      const variants = product.variants ?? [];
      if (variants.length > 0) {
        variants.forEach((variant, idx) => {
          rows.push({ product, variant, variantIndex: idx });
        });
      } else {
        rows.push({ product, variant: null, variantIndex: 0 });
      }
    }
    return rows;
  }, [products]);

  const filteredAndSorted = useMemo(() => {
    let list = [...flattenedRows];
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((row) => {
        const p = row.product;
        const v = row.variant;
        return (
          (p.title ?? "").toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q) ||
          (p.product_type ?? "").toLowerCase().includes(q) ||
          (v?.sku ?? "").toLowerCase().includes(q) ||
          (v?.option1 ?? "").toLowerCase().includes(q) ||
          (v?.title ?? "").toLowerCase().includes(q)
        );
      });
    }
    if (statusFilter) list = list.filter((row) => (row.product.status ?? "active") === statusFilter);
    if (typeFilter)
      list = list.filter((row) => (row.product.product_type ?? "").toLowerCase() === typeFilter.toLowerCase());
    const rowPrice = (row: ProductListRow) => row.variant?.price ?? row.product.price ?? 0;
    switch (sort) {
      case "name_asc":
        list.sort((a, b) => (a.product.title ?? "").localeCompare(b.product.title ?? ""));
        break;
      case "name_desc":
        list.sort((a, b) => (b.product.title ?? "").localeCompare(a.product.title ?? ""));
        break;
      case "price_asc":
        list.sort((a, b) => rowPrice(a) - rowPrice(b));
        break;
      case "price_desc":
        list.sort((a, b) => rowPrice(b) - rowPrice(a));
        break;
      case "oldest":
        list.sort((a, b) => {
          const ta = a.product.created_at ? new Date(a.product.created_at).getTime() : 0;
          const tb = b.product.created_at ? new Date(b.product.created_at).getTime() : 0;
          return ta - tb;
        });
        break;
      case "newest":
      default:
        list.sort((a, b) => {
          const ta = a.product.created_at ? new Date(a.product.created_at).getTime() : 0;
          const tb = b.product.created_at ? new Date(b.product.created_at).getTime() : 0;
          return tb - ta;
        });
        break;
    }
    return list;
  }, [flattenedRows, search, statusFilter, typeFilter, sort]);

  const uniqueTypes = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => {
      const t = (p.product_type ?? "").trim();
      if (t) set.add(t);
    });
    return Array.from(set).sort();
  }, [products]);

  const columns: DataGridColumn<ProductListRow>[] = [
    {
      key: "actions",
      label: "",
      render: (_, row) => {
        const rowId = getRowId(row);
        return (
          <div className="relative inline-block">
            <button
              type="button"
              onClick={() => setActionsOpenId(actionsOpenId === rowId ? null : rowId)}
              className="dropdown-toggle rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              aria-label="Actions"
            >
              <HorizontaLDots className="h-5 w-5" />
            </button>
            <Dropdown
              isOpen={actionsOpenId === rowId}
              onClose={() => setActionsOpenId(null)}
              className="left-0 right-auto min-w-[120px]"
            >
              <DropdownItem onClick={() => openEdit(row.product, row.variantIndex)}>Edit</DropdownItem>
              <DropdownItem
                onClick={() => handleDelete(row.product)}
                className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-900/20"
              >
                Delete
              </DropdownItem>
            </Dropdown>
          </div>
        );
      },
    },
    { key: "title", label: "Product", render: (_, row) => String(row.product.title || "—") },
    {
      key: "sku",
      label: "SKU",
      render: (_, row) =>
        String((row.variant?.sku ?? row.product.sku ?? "").trim() || "—"),
    },
    { key: "product_type", label: "Type", render: (_, row) => String(row.product.product_type || "—") },
    {
      key: "option",
      label: "Option",
      render: (_, row) => String(row.variant?.option1 ?? row.variant?.title ?? "—"),
    },
    {
      key: "price",
      label: "Price",
      align: "right",
      render: (_, row) => {
        const p = row.variant?.price ?? row.product.price;
        const old = row.product.price_old;
        if (p != null && old != null)
          return (
            <span>
              {Number(p).toFixed(2)}{" "}
              <span className="text-gray-400 line-through text-xs">{Number(old).toFixed(2)}</span>
            </span>
          );
        if (p != null) return Number(p).toFixed(2);
        return "—";
      },
    },
    { key: "status", label: "Status", render: (_, row) => String(row.product.status || "active") },
    {
      key: "source",
      label: "Source",
      render: (_, row) =>
        row.product.source
          ? String(row.product.source).charAt(0).toUpperCase() + String(row.product.source).slice(1).toLowerCase()
          : "—",
    },
  ];

  return (
    <div>
      <PageMeta
        title="Products | UniSell"
        description="All products from your connected stores and local catalog."
      />
      <PageBreadcrumb pageTitle="Products" />

      <div className="space-y-4">
        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
            {error}
          </div>
        )}
        {syncWarning && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
            {syncWarning.includes("Setup → Company Integrations") ? (
              <>
                {syncWarning.split("Setup → Company Integrations")[0]}
                <Link to="/company-integrations" className="font-medium underline hover:no-underline">
                  Setup → Company Integrations
                </Link>
                {syncWarning.split("Setup → Company Integrations")[1] || ""}
              </>
            ) : (
              syncWarning
            )}
            <button
              type="button"
              onClick={() => setSyncWarning(null)}
              className="ml-2 underline focus:outline-none"
            >
              Dismiss
            </button>
          </div>
        )}

        {formVisible ? (
          <div
            ref={formContainerRef}
            className="overflow-hidden rounded-2xl border border-gray-200/90 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900/50"
          >
            <div className="border-b border-gray-100 px-6 py-4 dark:border-gray-800">
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
                {editing
                  ? editingVariantIndex != null
                    ? "Edit variant"
                    : "Edit product"
                  : "Add product"}
              </h2>
              {editing && editingVariantIndex != null && (
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Editing this variant only. Other variants of &quot;{editing.title}&quot; are unchanged.
                </p>
              )}
            </div>

            <form id="product-form" onSubmit={handleSave} className="p-6">
              <div className="grid gap-8 lg:grid-cols-2">
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

                  {editingVariantIndex == null && (
                    <section className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Variants
                      </h3>
                      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                        Add variant options (e.g. size/color) with SKU and price. One product can have multiple variants on Shopify.
                      </p>
                      <div className="space-y-3">
                        {form.variants.map((v, i) => (
                          <div
                            key={i}
                            className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-800"
                          >
                            <Input
                              value={v.sku ?? ""}
                              onChange={(e) => updateVariant(i, "sku", e.target.value)}
                              placeholder="SKU"
                              className="flex-1 min-w-[80px]"
                            />
                            <Input
                              value={v.option1 ?? v.title ?? ""}
                              onChange={(e) => updateVariant(i, "option1", e.target.value)}
                              placeholder="Option (e.g. Size)"
                              className="flex-1 min-w-[80px]"
                            />
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={v.price != null ? String(v.price) : ""}
                              onChange={(e) =>
                                updateVariant(i, "price", e.target.value === "" ? undefined : Number(e.target.value))
                              }
                              placeholder="Price"
                              className="w-24"
                            />
                            <button
                              type="button"
                              onClick={() => removeVariant(i)}
                              className="rounded p-1.5 text-gray-500 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/20"
                              aria-label="Remove variant"
                            >
                              <TrashBinIcon className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={addVariant}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-600 hover:border-sky-400 hover:text-sky-600 dark:border-gray-600 dark:text-gray-400 dark:hover:border-sky-500 dark:hover:text-sky-400"
                        >
                          <PlusIcon className="h-4 w-4" />
                          Add variant
                        </button>
                      </div>
                    </section>
                  )}
                </div>

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
                      {!editing && (
                        <div>
                          <Label>Company (required to publish on Shopify)</Label>
                          <select
                            value={form.company_id}
                            onChange={(e) => setForm((f) => ({ ...f, company_id: e.target.value }))}
                            className="mt-1.5 h-11 w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-800 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
                          >
                            <option value="">Select company (product will be local only if empty)</option>
                            {companies.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name || c.id}
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                            Pick a company that has Shopify connected in Setup → Company Integrations so the product appears in your Shopify store.
                          </p>
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="rounded-xl border border-gray-100 bg-gray-50/50 p-5 dark:border-gray-800 dark:bg-gray-800/30">
                    <Label>Product description</Label>
                    <TextArea
                      value={form.description}
                      onChange={(v) => setForm((f) => ({ ...f, description: v }))}
                      placeholder="Enter product description here."
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
                      Add image URLs (one per line). Image upload can be added later.
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

              <div className="mt-8 flex flex-wrap items-center justify-end gap-3 border-t border-gray-200 pt-6 dark:border-gray-700">
                <button
                  type="button"
                  onClick={closeForm}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-sky-700 disabled:opacity-60 dark:bg-sky-500 dark:hover:bg-sky-600"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-[200px] flex-1">
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, SKU, option or type…"
                  className="rounded-lg border-gray-200 dark:border-gray-600"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                >
                  <option value="">All statuses</option>
                  <option value="active">Active</option>
                  <option value="published">Published</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="hidden">Hidden</option>
                </select>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                >
                  <option value="">All types</option>
                  {uniqueTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="name_asc">Name A–Z</option>
                  <option value="name_desc">Name Z–A</option>
                  <option value="price_asc">Price: low to high</option>
                  <option value="price_desc">Price: high to low</option>
                </select>
                <button
                  type="button"
                  onClick={openCreate}
                  className="rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-sky-700 dark:bg-sky-500 dark:hover:bg-sky-600"
                >
                  Add product
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200/90 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900/50">
              <DataGrid
                columns={columns}
                data={filteredAndSorted}
                keyExtractor={(row) => `${row.product.id}-${row.variantIndex}`}
                emptyMessage="No products match your filters. Add a product to get started."
                loading={loading}
              />
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Each variant is shown as a separate row. Edit or Delete applies to the whole product.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
