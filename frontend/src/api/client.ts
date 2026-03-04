export const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

const TOKEN_KEY = "token";
const USER_KEY = "user";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** Open consignment label in new window (uses auth). Pass a window opened on click to avoid pop-up blockers. */
export async function openConsignmentLabel(
  consignmentId: string,
  targetWindow?: Window | null
): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/api/tenant/consignments/${consignmentId}/label`, {
    redirect: "manual",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const w = targetWindow ?? null;

  if (res.status === 302) {
    const url = res.headers.get("Location");
    if (url) {
      if (w) w.location.href = url;
      else window.open(url, "_blank");
    }
    return;
  }
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const isPdfOrImage =
    contentType.includes("application/pdf") ||
    contentType.includes("pdf") ||
    contentType.startsWith("image/") ||
    contentType.includes("application/octet-stream");
  if (res.ok && isPdfOrImage) {
    const blob = await res.blob();
    const blobType = blob.type?.toLowerCase() || "";
    const forcePdf =
      !blobType.includes("image/") &&
      (blobType.includes("octet-stream") || !blobType || blobType.includes("pdf"));
    const finalBlob =
      forcePdf && blob.size > 0
        ? new Blob([blob], { type: "application/pdf" })
        : blob;
    const url = URL.createObjectURL(finalBlob);
    if (w) {
      w.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else {
      const opened = window.open(url, "_blank", "noopener");
      if (opened) setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    return;
  }
  if (res.ok && contentType.includes("text/html")) {
    const html = await res.text();
    if (w) {
      w.document.write(html);
      w.document.close();
    } else {
      const opened = window.open("", "_blank");
      if (opened) {
        opened.document.write(html);
        opened.document.close();
      }
    }
    return;
  }
  if (!res.ok) {
    if (w && !w.closed) w.close();
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "Failed to load label");
  }
  if (res.ok) {
    const blob = await res.blob();
    const finalBlob =
      blob.size > 0 && !(blob.type || "").toLowerCase().startsWith("image/")
        ? new Blob([blob], { type: "application/pdf" })
        : blob;
    const url = URL.createObjectURL(finalBlob);
    if (w) {
      w.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else {
      const opened = window.open(url, "_blank", "noopener");
      if (opened) setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    return;
  }
  if (w && !w.closed) w.close();
  throw new Error("Unsupported label format");
}

let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers as Record<string, string>),
    },
  });
  if (res.status === 401 && onUnauthorized) {
    onUnauthorized();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Types
export type IntegrationCredentialSchema = { key: string; label: string; type: string; placeholder?: string; required?: boolean };

export type Company = {
  id: string;
  name: string;
  address?: { address1?: string; city?: string; postal_code?: string; country_code?: string };
  created_at?: string;
  updated_at?: string;
};

export type CompanyIntegration = {
  id: string;
  company_id: string;
  integration_id: string;
  credentials?: Record<string, unknown>;
  status?: number;
  company_name?: string;
  created_at?: string;
  updated_at?: string;
};

export type Order = {
  id: string;
  company_id: string | null;
  company_name: string | null;
  status: string;
  external_id?: string;
  order_number?: string | number;
  email?: string;
  total?: number;
  financial_status?: string;
  fulfillment_status?: string;
  source?: string;
  created_at?: string;
  address?: {
    address1?: string;
    city?: string;
    postal_code?: string;
    country_code?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
  };
};

export type Consignment = {
  id: string;
  order_id: string;
  carrier_integration_id?: string;
  carrier_service_id?: string;
  carrier_name?: string;
  carrier_service_name?: string;
  tracking_number: string;
  label_url: string | null;
  tracking_url: string | null;
  status?: string;
  carrier_name?: string;
  carrier_service_name?: string;
  created_at?: string;
  updated_at?: string;
};

export type ProductVariant = {
  id?: string;
  sku?: string;
  title?: string;
  option1?: string;
  price?: number;
  inventory_quantity?: number;
};

export type Product = {
  id: string;
  company_id: string | null;
  company_name?: string | null;
  external_id?: string | null;
  title: string;
  sku?: string | null;
  product_type?: string | null;
  status?: string;
  source?: string;
  price?: number | null;
  price_old?: number | null;
  coupon?: string | null;
  page_title?: string | null;
  handle?: string | null;
  description?: string | null;
  sizes?: string[];
  shipping_country?: string | null;
  images?: string[];
  variants?: ProductVariant[];
  variant_count?: number;
  created_at?: string;
  updated_at?: string;
};

export type CarrierIntegration = {
  id: string;
  carrier_id: string;
  credentials?: Record<string, unknown>;
  credentials_schema?: IntegrationCredentialSchema[];
  created_at?: string;
  updated_at?: string;
};

export type CarrierIntegrationService = {
  id: string;
  carrier_integration_id: string;
  carrier_service_id: string;
  code?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
};

// Auth API (no Bearer for signup/login)
export type LoginResponse = { token: string; user: { email: string; role: string; tenant_name?: string; isSuperadmin: boolean } };
export type TenantRow = { id: string; tenant_name: string; email: string; status: string; created_at?: string };

export const authApi = {
  login: (body: { email: string; password: string }) =>
    fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Login failed");
      return data as LoginResponse;
    }),
  signup: (body: { email: string; password: string; tenant_name: string }) =>
    fetch(`${API_BASE}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Signup failed");
      return data as { message?: string };
    }),
  getTenants: () =>
    api<TenantRow[]>("/api/auth/tenants"),
  approveTenant: (id: string) =>
    api<{ message: string }>(`/api/auth/tenants/${id}/approve`, { method: "POST" }),
  rejectTenant: (id: string) =>
    api<{ message: string }>(`/api/auth/tenants/${id}/reject`, { method: "POST" }),
};

// Tenant API
export const tenantApi = {
  getCompanies: () =>
    api<{ companies: Company[] }>("/api/tenant/companies"),
  createCompany: (body: { name: string; address1?: string; city?: string; postal_code?: string; country_code?: string }) =>
    api<Company>("/api/tenant/companies", { method: "POST", body: JSON.stringify(body) }),
  updateCompany: (id: string, body: { name: string; address1?: string; city?: string; postal_code?: string; country_code?: string }) =>
    api<Company>(`/api/tenant/companies/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteCompany: (id: string) =>
    api<{ message: string }>(`/api/tenant/companies/${id}`, { method: "DELETE" }),
  getIntegrations: () =>
    api<{ integrations: Array<{ id: string; name: string; slug: string; credentials_schema: IntegrationCredentialSchema[] }> }>("/api/tenant/integrations"),
  getCompanyIntegrations: () =>
    api<{ company_integrations: CompanyIntegration[] }>("/api/tenant/company-integrations"),
  createCompanyIntegration: (body: { company_id: string; integration_id: string; credentials?: Record<string, unknown>; status?: number }) =>
    api<CompanyIntegration>("/api/tenant/company-integrations", { method: "POST", body: JSON.stringify(body) }),
  updateCompanyIntegration: (id: string, body: { company_id?: string; credentials?: Record<string, unknown>; status?: number }) =>
    api<CompanyIntegration>(`/api/tenant/company-integrations/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteCompanyIntegration: (id: string) =>
    api<{ message: string }>(`/api/tenant/company-integrations/${id}`, { method: "DELETE" }),
  getOrders: (params?: { company_id?: string }) => {
    const q = params?.company_id ? `?company_id=${encodeURIComponent(params.company_id)}` : "";
    return api<{ orders: Order[] }>(`/api/tenant/orders${q}`);
  },
  getConsignments: (params?: { order_id?: string }) => {
    const q = params?.order_id ? `?order_id=${encodeURIComponent(params.order_id)}` : "";
    return api<{ consignments: Consignment[] }>(`/api/tenant/consignments${q}`);
  },
  getCarriers: () =>
    api<{ carriers: Array<{ id: string; name: string; slug: string; credentials_schema: IntegrationCredentialSchema[] }> }>("/api/tenant/carriers"),
  getCarrierIntegrations: () =>
    api<{ carrier_integrations: CarrierIntegration[] }>("/api/tenant/carrier-integrations"),
  getCarrierServices: (params?: { carrier_id?: string }) => {
    const q = params?.carrier_id ? `?carrier_id=${encodeURIComponent(params.carrier_id)}` : "";
    return api<{ carrier_services: Array<{ id: string; carrier_id: string; name: string; code: string }> }>(`/api/tenant/carrier-services${q}`);
  },
  createCarrierIntegration: (body: { carrier_id: string; credentials?: Record<string, unknown>; status?: number }) =>
    api<CarrierIntegration>("/api/tenant/carrier-integrations", { method: "POST", body: JSON.stringify(body) }),
  updateCarrierIntegration: (id: string, body: { credentials?: Record<string, unknown>; status?: number }) =>
    api<CarrierIntegration>(`/api/tenant/carrier-integrations/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteCarrierIntegration: (id: string) =>
    api<{ message: string }>(`/api/tenant/carrier-integrations/${id}`, { method: "DELETE" }),
  getCarrierIntegrationServices: (params?: { carrier_integration_id?: string }) => {
    const q = params?.carrier_integration_id ? `?carrier_integration_id=${encodeURIComponent(params.carrier_integration_id)}` : "";
    return api<{ carrier_integration_services: CarrierIntegrationService[] }>(`/api/tenant/carrier-integration-services${q}`);
  },
  createCarrierIntegrationService: (body: { carrier_integration_id: string; carrier_service_id: string }) =>
    api<CarrierIntegrationService>("/api/tenant/carrier-integration-services", { method: "POST", body: JSON.stringify(body) }),
  deleteCarrierIntegrationService: (id: string) =>
    api<void>(`/api/tenant/carrier-integration-services/${id}`, { method: "DELETE" }),
  createConsignments: (body: {
    order_ids: string[];
    carrier_integration_id: string;
    carrier_service_id: string;
  }) =>
    api<{ created: number; errors: Array<{ order_id: string; error: string }> }>("/api/tenant/consignments", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  dispatchOrders: (body: { order_ids: string[] }) =>
    api<{ dispatched: number; errors: Array<{ order_id: string; error: string }> }>("/api/tenant/orders/dispatch", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  backfillOrdersCompany: (body: { company_id: string; source: string }) =>
    api<{ updated: number }>("/api/tenant/orders/backfill-company", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getProducts: (params?: { company_id?: string }) => {
    const q = params?.company_id ? `?company_id=${encodeURIComponent(params.company_id)}` : "";
    return api<{ products: Product[] }>(`/api/tenant/products${q}`);
  },
  createProduct: (body: {
    title: string;
    company_id?: string;
    sku?: string;
    product_type?: string;
    price?: number;
    price_old?: number;
    coupon?: string;
    status?: string;
    source?: string;
    page_title?: string;
    handle?: string;
    description?: string;
    sizes?: string[];
    shipping_country?: string;
    images?: string[];
    variants?: ProductVariant[];
  }) =>
    api<Product>("/api/tenant/products", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProduct: (
    id: string,
    body: {
      title?: string;
      sku?: string;
      product_type?: string;
      price?: number;
      price_old?: number;
      coupon?: string;
      status?: string;
      page_title?: string;
      handle?: string;
      description?: string;
      sizes?: string[];
      shipping_country?: string;
      images?: string[];
      variants?: ProductVariant[];
    }
  ) =>
    api<Product>(`/api/tenant/products/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteProduct: (id: string) =>
    api<{ message: string }>(`/api/tenant/products/${id}`, { method: "DELETE" }),
};
