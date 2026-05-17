/**
 * Leopard Courier (Pakistan) – Merchant API bookPacket.
 * URL and body only as provided: no extra credentials or URL variants.
 */

const BOOK_PACKET_URL = "https://merchantapi.leopardscourier.com/api/bookPacket/format/json/";
const TRACKING_BASE_URL = "https://www.leopardscourier.com/tracking";
const LOG_PREFIX = "[Leopard]";

function log(level, msg, meta = {}) {
  const payload = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  if (level === "error") console.error(`${LOG_PREFIX} ${msg}${payload}`);
  else console.log(`${LOG_PREFIX} ${msg}${payload}`);
}

/** Sanitize body for logging (mask api_key, api_password). */
function sanitizeBody(body) {
  if (!body || typeof body !== "object") return body;
  const s = { ...body };
  if (s.api_key) s.api_key = "***";
  if (s.api_password) s.api_password = "***";
  return s;
}

/**
 * Leopard API expects origin_city and destination_city as:
 * - "self" (use account default), OR
 * - numeric city ID from getAllCities (e.g. 789 for Lahore).
 * City names like "Karachi" are invalid and cause "This city is disabled".
 */

function normalizeCredentials(credentials) {
  if (!credentials || typeof credentials !== "object") {
    return { apiKey: "", apiPassword: "", originCityId: null, destinationCityId: null };
  }
  const apiKey = (credentials.api_key ?? "").toString().trim();
  const apiPassword = (credentials.api_password ?? "").toString().trim();
  const rawOrigin = credentials.origin_city_id ?? credentials.default_origin_city ?? "";
  const rawDest = credentials.destination_city_id ?? credentials.default_destination_city ?? "";
  const originCityId = parseCityId(rawOrigin);
  const destinationCityId = parseCityId(rawDest);
  return { apiKey, apiPassword, originCityId, destinationCityId };
}

function parseCityId(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const n = parseInt(String(value).trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/** Leopard API expects weight in grams. Accepts grams or kg (if < 50 assume kg and convert). */
function toWeightGrams(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1000;
  if (n > 0 && n < 50) return Math.round(n * 1000);
  return Math.round(n);
}

function getShippingFromOrder(order) {
  const raw = order?.raw || {};
  return order?.shipping_address || raw.shipping_address || raw.shippingAddress || {};
}

function buildShipment(company) {
  const name = company?.name || company?.address?.company_name || "Shipper";
  const email = company?.email || "shipper@example.com";
  const phone = company?.phone || company?.address?.phone || "0000000000";
  const address =
    company?.address1 ||
    company?.address?.address1 ||
    (company?.address && typeof company.address === "object" && company.address.address1) ||
    "Shipper Address";
  const addressStr =
    typeof address === "string"
      ? address
      : [address?.line1, address?.line2, address?.city].filter(Boolean).join(", ") || "Shipper Address";
  return {
    shipment_name_eng: String(name).slice(0, 100),
    shipment_email: String(email).slice(0, 100),
    shipment_phone: String(phone).slice(0, 20),
    shipment_address: addressStr.slice(0, 200),
  };
}

function buildConsignment(shipping) {
  const name =
    [shipping.first_name, shipping.last_name].filter(Boolean).join(" ") ||
    shipping.name ||
    "Recipient";
  const email = shipping.email || "recipient@example.com";
  const phone = shipping.phone || "0000000000";
  const address =
    shipping.address1 ||
    shipping.address_1 ||
    [shipping.address1, shipping.address2, shipping.city].filter(Boolean).join(", ") ||
    "Recipient Address";
  return {
    consignment_name_eng: String(name).slice(0, 100),
    consignment_email: String(email).slice(0, 100),
    consignment_phone: String(phone).slice(0, 20),
    consignment_address: String(address).slice(0, 200),
  };
}

function getTrackingNumber(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data.track_number,
    data.tracking_number,
    data.TrackNumber,
    data.trackingNumber,
    data.awb_number,
    data.awb,
    data.AWB,
    data.booking_number,
    data.packet_number,
    data.reference_number,
  ];
  if (data.data && typeof data.data === "object") {
    candidates.push(
      data.data.track_number,
      data.data.tracking_number,
      data.data.TrackNumber,
      data.data.trackingNumber,
      data.data.awb_number,
      data.data.awb,
      data.data.booking_number
    );
  }
  const found = candidates.find((v) => v != null && String(v).trim() !== "");
  return found != null ? String(found).trim() : null;
}

/** Leopard may return slip/label URL on success (e.g. slip_link). Same as DHL we store it so Print label can open PDF or redirect. */
function getLabelUrl(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data.slip_link,
    data.slip_url,
    data.label_url,
    data.label_url_pdf,
    data.pdf_url,
    data.label_pdf,
    data.shipping_label_url,
  ];
  if (data.data && typeof data.data === "object") {
    candidates.push(
      data.data.slip_link,
      data.data.slip_url,
      data.data.label_url,
      data.data.label_url_pdf,
      data.data.pdf_url,
      data.data.label_pdf
    );
  }
  const found = candidates.find((v) => v != null && String(v).trim() !== "");
  return found != null ? String(found).trim() : null;
}

function buildTrackingUrl(trackingNumber) {
  if (!trackingNumber) return TRACKING_BASE_URL;
  return `${TRACKING_BASE_URL}?tracking=${encodeURIComponent(trackingNumber)}`;
}

function buildBookPacketBody({
  apiKey,
  apiPassword,
  shipment,
  consignment,
  weightGrams = 1000,
  noOfPieces = 1,
  collectAmount = "0",
  specialInstructions = "",
  originCityValue,
  destinationCityValue,
}) {
  const special = String(specialInstructions || "").trim();
  return {
    api_key: apiKey,
    api_password: apiPassword,
    booked_packet_weight: Number(weightGrams) > 0 ? Number(weightGrams) : 1000,
    booked_packet_no_piece: Number(noOfPieces) || 1,
    booked_packet_collect_amount: String(collectAmount ?? "0"),
    origin_city: originCityValue === "self" ? "self" : originCityValue,
    destination_city: destinationCityValue === "self" ? "self" : destinationCityValue,
    ...shipment,
    ...consignment,
    special_instructions: special.length ? special.slice(0, 500) : "N/A",
  };
}

export class LeopardIntegration {
  static slug = "leopard";

  /**
   * Create a shipment via Leopard bookPacket API.
   * @param {object} credentials - api_key, api_password; optional account_number, base_url
   * @param {object} order - Order with shipping address
   * @param {string} _serviceCode - Unused
   * @param {object|null} company - Sender (shipment_*)
   * @returns {Promise<{ trackingNumber: string, labelUrl: string | null, trackingUrl: string }>}
   */
  static async createShipment(credentials, order, _serviceCode, company = null) {
    const { apiKey, apiPassword, originCityId, destinationCityId } = normalizeCredentials(credentials);

    if (!apiKey || !apiPassword) {
      log("error", "createShipment: missing credentials (api_key or api_password)");
      throw new Error("Leopard credentials missing: api_key and api_password are required");
    }

    const shipping = getShippingFromOrder(order);
    const shipment = buildShipment(company || {});
    const consignment = buildConsignment(shipping);

    const collectAmount =
      order?.cod_amount ?? order?.raw?.cod_amount ?? order?.total_price ?? "0";
    const rawWeight = order?.total_weight ?? order?.raw?.total_weight ?? 1;
    const weightGrams = toWeightGrams(rawWeight);

    const originCityValue = originCityId != null ? originCityId : "self";
    const destinationCityValue = destinationCityId != null ? destinationCityId : "self";

    const body = buildBookPacketBody({
      apiKey,
      apiPassword,
      shipment,
      consignment,
      weightGrams,
      noOfPieces: 1,
      collectAmount: String(collectAmount),
      specialInstructions: order?.note ?? order?.raw?.note ?? "",
      originCityValue,
      destinationCityValue,
    });

    log("info", "createShipment: request", {
      url: BOOK_PACKET_URL,
      body: sanitizeBody(body),
      order_id: order?._id?.toString?.(),
    });

    let res;
    let data = {};
    try {
      res = await fetch(BOOK_PACKET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { message: text || `HTTP ${res.status}` };
      }
      log("info", "createShipment: response", {
        status: res.status,
        ok: res.ok,
        data: res.ok ? sanitizeBody(data) : data,
      });
    } catch (err) {
      log("error", "createShipment: fetch failed", { message: err.message, stack: err.stack });
      throw new Error(`Leopard API request failed: ${err.message}`);
    }

    if (!res.ok) {
      const detail =
        data.error ||
        data.message ||
        data.detail ||
        (data.data && (data.data.message || data.data.error)) ||
        `HTTP ${res.status}`;
      log("error", "createShipment: API error response", {
        status: res.status,
        detail,
        response: data,
      });
      if (res.status === 401) {
        throw new Error(
          "Leopard credentials are invalid. Check api_key and api_password in your Leopard carrier integration."
        );
      }
      throw new Error(`Leopard API ${res.status}: ${detail}`);
    }

    if (data.status === 0 && data.error) {
      log("error", "createShipment: API returned status 0", { error: data.error, response: data });
      throw new Error(`Leopard API: ${data.error}`);
    }

    const trackingNumber = getTrackingNumber(data);
    if (!trackingNumber) {
      const raw = JSON.stringify(data).slice(0, 500);
      log("error", "createShipment: no tracking number in response", { response: data });
      throw new Error(
        `Leopard API returned success but no tracking number in response. Response: ${raw}`
      );
    }

    const labelUrl = getLabelUrl(data);
    const trackingUrl = buildTrackingUrl(trackingNumber);
    if (labelUrl) {
      log("info", "createShipment: success (label from API)", { trackingNumber, hasLabel: true, order_id: order?._id?.toString?.() });
    } else {
      log("info", "createShipment: success (no label URL; use Print label for HTML slip)", {
        trackingNumber,
        hasLabel: false,
        order_id: order?._id?.toString?.(),
        responseKeys: data && typeof data === "object" ? Object.keys(data) : [],
      });
    }

    return {
      trackingNumber,
      labelUrl: labelUrl || null,
      trackingUrl,
    };
  }
}
