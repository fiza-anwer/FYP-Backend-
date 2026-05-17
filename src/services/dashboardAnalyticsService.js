import { ObjectId } from "mongodb";

const STRATEGIES = [
  {
    id: "discount",
    label: "Limited-time discount",
    detail: "Offer 10–20% off to spark new orders this month.",
  },
  {
    id: "bundle",
    label: "Bundle with hero product",
    detail: "Pair with your bestseller as a value pack.",
  },
  {
    id: "packaging",
    label: "Premium packaging",
    detail: "Gift-ready packaging can lift conversion for jewellery and fashion.",
  },
  {
    id: "featured",
    label: "Featured placement",
    detail: "Highlight on storefront, Daraz campaigns, or social posts.",
  },
  {
    id: "clearance",
    label: "Clearance / flash sale",
    detail: "Move slow stock with a short clearance window.",
  },
];

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function monthKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [y, m] = key.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

function pickStrategy(productId) {
  const s = String(productId);
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash + s.charCodeAt(i)) % 997;
  return STRATEGIES[hash % STRATEGIES.length];
}

function orderDate(order) {
  const d = order.created_at || order.updated_at;
  return d ? new Date(d) : null;
}

function extractLineItems(order) {
  const out = [];
  if (Array.isArray(order.line_items) && order.line_items.length > 0) {
    for (const li of order.line_items) {
      if (li?.product_id) {
        out.push({
          product_id: li.product_id.toString(),
          quantity: Math.max(1, Number(li.quantity) || 1),
        });
      }
    }
    return out;
  }
  const rawLines = order.raw?.line_items;
  if (!Array.isArray(rawLines)) return out;
  for (const li of rawLines) {
    const qty = Math.max(1, parseInt(li.quantity ?? 1, 10) || 1);
    const sku = (li.sku || li.SellerSku || "").trim();
    out.push({ sku, quantity: qty, name: li.name || li.title || "" });
  }
  return out;
}

/**
 * Build tenant dashboard analytics from orders + products.
 */
export async function getDashboardAnalytics(tenantDb) {
  const ordersColl = tenantDb.collection("orders");
  const productsColl = tenantDb.collection("products");

  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const chartDaysStart = new Date(now);
  chartDaysStart.setDate(chartDaysStart.getDate() - 29);

  const revenueMonthStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  const [orders, products] = await Promise.all([
    ordersColl.find({}).sort({ created_at: -1 }).limit(5000).toArray(),
    productsColl.find({}).project({ title: 1, sku: 1, price: 1, product_type: 1, company_id: 1 }).toArray(),
  ]);

  const productMap = new Map();
  for (const p of products) {
    productMap.set(p._id.toString(), {
      product_id: p._id.toString(),
      title: p.title || "Product",
      sku: p.sku || "",
      price: p.price,
      product_type: p.product_type || "",
    });
  }

  const skuToProductId = new Map();
  for (const p of products) {
    if (p.sku) skuToProductId.set(String(p.sku).trim().toLowerCase(), p._id.toString());
    for (const v of p.variants || []) {
      if (v?.sku) skuToProductId.set(String(v.sku).trim().toLowerCase(), p._id.toString());
    }
  }

  const productOrderCounts = new Map();
  const productOrderCountsMonth = new Map();
  const productLastOrder = new Map();
  const ordersByDay = new Map();
  const revenueByMonth = new Map();

  for (let i = 0; i < 30; i++) {
    const d = new Date(chartDaysStart);
    d.setDate(chartDaysStart.getDate() + i);
    ordersByDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (let m = 0; m < 12; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() - (11 - m), 1);
    revenueByMonth.set(monthKey(d), 0);
  }

  let recentOrdersPayload = [];

  for (const order of orders) {
    const created = orderDate(order);
    const dayKey = created ? startOfDay(created).toISOString().slice(0, 10) : null;
    const mKey = created ? monthKey(created) : null;

    if (dayKey && ordersByDay.has(dayKey)) {
      ordersByDay.set(dayKey, (ordersByDay.get(dayKey) || 0) + 1);
    }

    if (created && created >= revenueMonthStart && mKey) {
      const total = parseFloat(order.total) || 0;
      revenueByMonth.set(mKey, (revenueByMonth.get(mKey) || 0) + total);
    }

    let lines = extractLineItems(order);
    const resolvedLines = [];
    for (const li of lines) {
      let pid = li.product_id;
      if (!pid && li.sku) {
        pid = skuToProductId.get(String(li.sku).trim().toLowerCase());
      }
      if (pid) resolvedLines.push({ product_id: pid, quantity: li.quantity });
    }

    if (resolvedLines.length === 0) continue;

    for (const li of resolvedLines) {
      const pid = li.product_id;
      productOrderCounts.set(pid, (productOrderCounts.get(pid) || 0) + li.quantity);
      if (created && created >= monthStart) {
        productOrderCountsMonth.set(pid, (productOrderCountsMonth.get(pid) || 0) + li.quantity);
      }
      if (created) {
        const prev = productLastOrder.get(pid);
        if (!prev || created > prev) productLastOrder.set(pid, created);
      }
    }
  }

  recentOrdersPayload = orders.slice(0, 5).map((o) => {
    let company_name = null;
    return {
      id: o._id.toString(),
      order_number: o.order_number || o.external_id,
      email: o.email || "",
      total: o.total,
      status: o.status || "imported",
      source: o.source,
      created_at: o.created_at,
      company_name,
    };
  });

  const companiesColl = tenantDb.collection("companies");
  for (const ro of recentOrdersPayload) {
    const o = orders.find((x) => x._id.toString() === ro.id);
    if (o?.company_id) {
      const c = await companiesColl.findOne({ _id: o.company_id });
      ro.company_name = c?.name || null;
    }
  }

  function topProductFromMap(map) {
    let bestId = null;
    let bestCount = 0;
    for (const [pid, count] of map) {
      if (count > bestCount) {
        bestCount = count;
        bestId = pid;
      }
    }
    if (!bestId) return null;
    const meta = productMap.get(bestId) || { product_id: bestId, title: "Product", sku: "" };
    return { ...meta, order_count: bestCount };
  }

  const heroProduct = topProductFromMap(productOrderCounts);
  const heroProductMonth = topProductFromMap(productOrderCountsMonth);

  const topProducts = [...productOrderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pid, count]) => {
      const meta = productMap.get(pid) || { product_id: pid, title: "Product", sku: "" };
      return { ...meta, order_count: count };
    });

  const staleProducts = [];
  for (const p of products) {
    const pid = p._id.toString();
    const last = productLastOrder.get(pid);
    if (!last || last < thirtyDaysAgo) {
      const strategy = pickStrategy(pid);
      staleProducts.push({
        product_id: pid,
        title: p.title || "Product",
        sku: p.sku || "",
        last_order_at: last ? last.toISOString() : null,
        days_without_order: last
          ? Math.floor((now - last) / (24 * 60 * 60 * 1000))
          : null,
        strategy,
      });
    }
  }
  staleProducts.sort((a, b) => {
    const da = a.last_order_at ? new Date(a.last_order_at).getTime() : 0;
    const db = b.last_order_at ? new Date(b.last_order_at).getTime() : 0;
    return da - db;
  });

  const orders_by_day = [...ordersByDay.entries()].map(([date, count]) => ({ date, count }));
  const revenue_by_month = [...revenueByMonth.entries()].map(([month, revenue]) => ({
    month,
    label: monthLabel(month),
    revenue: Math.round(revenue * 100) / 100,
  }));

  return {
    hero_product: heroProduct,
    hero_product_month: heroProductMonth,
    top_products: topProducts,
    recent_orders: recentOrdersPayload,
    orders_by_day,
    revenue_by_month,
    stale_products: staleProducts.slice(0, 20),
    summary: {
      total_orders: orders.length,
      total_products: products.length,
      orders_last_30_days: orders.filter((o) => {
        const d = orderDate(o);
        return d && d >= thirtyDaysAgo;
      }).length,
      revenue_this_month: revenueByMonth.get(monthKey(now)) || 0,
    },
  };
}
