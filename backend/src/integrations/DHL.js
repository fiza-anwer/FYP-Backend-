/**
 * DHL Express integration (MyDHL API).
 *
 * - Real-time label creation only; no mock data.
 * - Carrier stores: account number + API credentials (no shipper address).
 * - Origin (shipper) comes from the order’s company address when set.
 * - Destination (receiver) comes from the order’s shipping address.
 */

const DEFAULT_BASE_URL = "https://express.api.dhl.com/mydhlapi/test";

const PRODUCT_CODES = {
  express: "P",
  economy: "N",
  P: "P",
  N: "N",
  Y: "Y",
};

const DEFAULT_WEIGHT_KG = 1;
const DEFAULT_DIMENSIONS_CM = { length: 10, width: 10, height: 10 };

const DHL_ERROR_CODES = {
  PRODUCT_UNAVAILABLE: ["410138", "410301", "1001"],
  ORIGIN_INVALID: "420504",
};

const TRACKING_BASE_URL = "https://www.dhl.com/en/express/tracking.html";

// ——— Credentials ———

/** Extract a single quoted or unquoted value from env-style string like "DHL_Username='value'" or "DHL_BaseUrl= https://..." */
function parseEnvValue(str, key) {
  if (typeof str !== "string") return "";
  const re = new RegExp(`${key}\\s*=\\s*'([^']*)'|${key}\\s*=\\s*([^\\s]+)`, "i");
  const m = str.match(re);
  if (m) return (m[1] ?? m[2] ?? "").trim();
  return "";
}

/** Extract base URL from a string (handles "DHL_BaseUrl= https://.../shipments" or plain URL). Strips /shipments so we can append path later. */
function extractBaseUrl(value) {
  if (typeof value !== "string") return "";
  const s = value.trim();
  const urlMatch = s.match(/https?:\/\/[^\s'"]+/);
  if (!urlMatch) return /^https?:\/\//i.test(s) ? s.replace(/\/$/, "") : "";
  let url = urlMatch[0].replace(/\/$/, "");
  if (url.endsWith("/shipments")) url = url.slice(0, -"/shipments".length);
  return url;
}

function normalizeCredentials(credentials) {
  if (!credentials) {
    return { username: "", password: "", accountNumber: "", baseUrl: DEFAULT_BASE_URL };
  }
  if (typeof credentials === "string") {
    const username = parseEnvValue(credentials, "DHL_Username").trim();
    const password = parseEnvValue(credentials, "DHL_Password").trim();
    let baseUrl = extractBaseUrl(credentials) || parseEnvValue(credentials, "DHL_BaseUrl").trim();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) baseUrl = DEFAULT_BASE_URL;
    return { username, password, accountNumber: parseEnvValue(credentials, "account_number").trim(), baseUrl: baseUrl.replace(/\/$/, "") };
  }
  if (typeof credentials !== "object") {
    return { username: "", password: "", accountNumber: "", baseUrl: DEFAULT_BASE_URL };
  }
  let username = (credentials.username ?? credentials.api_key ?? credentials.DHL_Username ?? "").trim();
  let password = (credentials.password ?? credentials.api_secret ?? credentials.DHL_Password ?? "").trim();
  let accountNumber = (credentials.account_number ?? "").trim();
  let baseUrl = (credentials.base_url ?? credentials.DHL_BaseUrl ?? "").trim();

  const blob = [baseUrl, username, password, typeof credentials.DHL_Username === "string" ? credentials.DHL_Username : "", typeof credentials.DHL_Password === "string" ? credentials.DHL_Password : "", typeof credentials.DHL_BaseUrl === "string" ? credentials.DHL_BaseUrl : ""].find((s) => typeof s === "string" && s.includes("DHL_"));
  if (blob) {
    if (!username) username = parseEnvValue(blob, "DHL_Username").trim() || blob.replace(/^.*DHL_Username\s*=\s*'([^']*)'.*$/i, "$1").trim();
    if (!password) password = parseEnvValue(blob, "DHL_Password").trim() || blob.replace(/^.*DHL_Password\s*=\s*'([^']*)'.*$/i, "$1").trim();
    if (!baseUrl || baseUrl.includes("DHL_")) baseUrl = extractBaseUrl(blob) || parseEnvValue(blob, "DHL_BaseUrl").trim();
  }
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) baseUrl = DEFAULT_BASE_URL;
  baseUrl = baseUrl.replace(/\/$/, "");
  return { username, password, accountNumber, baseUrl };
}

function resolveProductCode(serviceCode) {
  const key = (serviceCode || "").toLowerCase();
  return PRODUCT_CODES[key] ?? "P";
}

// ——— Address & postal code ———

/** UK incode: digit + 2 letters. Used to validate/form postcodes for GB. */
const UK_POSTCODE_INCODE = /^\d[A-Z]{2}$/;

function formatPostalCode(postalCode, countryCode) {
  const pc = String(postalCode || "").trim().toUpperCase();
  if (countryCode === "GB" || countryCode === "UK") {
    const noSpace = pc.replace(/\s+/g, "");
    if (noSpace.length >= 5 && noSpace.length <= 7) {
      const outcode = noSpace.slice(0, -3);
      const incode = noSpace.slice(-3);
      if (UK_POSTCODE_INCODE.test(incode)) return `${outcode} ${incode}`;
    }
    if (pc.length >= 6 && pc.includes(" ")) {
      const parts = pc.split(/\s+/);
      const incode = parts[parts.length - 1];
      if (incode && UK_POSTCODE_INCODE.test(incode)) return pc;
    }
    return null;
  }
  return pc || null;
}

function placeholderPostalCode(countryCode) {
  const c = (countryCode || "").toUpperCase().slice(0, 2);
  if (c === "GB" || c === "UK") return "SW1A 1AA";
  if (c === "PK") return "54000";
  return "00000";
}

function placeholderCity(countryCode) {
  const c = (countryCode || "").toUpperCase().slice(0, 2);
  if (c === "PK") return "Lahore";
  if (c === "GB" || c === "UK") return "London";
  return "Shipper City";
}

/** Read shipping address from order (shipping_address or raw). */
function getShippingFromOrder(order) {
  const raw = order?.raw || {};
  return (
    order?.shipping_address ||
    raw.shipping_address ||
    raw.shippingAddress ||
    {}
  );
}

// ——— Rating API ———

/**
 * Fetch available product codes for the given route.
 * @param {object} opts - auth, baseUrl, accountNumber, origin, destination, plannedShippingDate, weight, dimensions, nextBusinessDay
 * @returns {Promise<string[]>}
 */
async function getAvailableProducts(opts) {
  const {
    auth,
    baseUrl,
    accountNumber,
    origin,
    destination,
    plannedShippingDate,
    weight = DEFAULT_WEIGHT_KG,
    length = DEFAULT_DIMENSIONS_CM.length,
    width = DEFAULT_DIMENSIONS_CM.width,
    height = DEFAULT_DIMENSIONS_CM.height,
    nextBusinessDay = false,
  } = opts;

  const params = new URLSearchParams({
    accountNumber,
    originCountryCode: origin.countryCode,
    originPostalCode: String(origin.postalCode || "").trim() || "00000",
    originCityName: String(origin.cityName || "").trim() || "City",
    destinationCountryCode: destination.countryCode,
    destinationPostalCode: String(destination.postalCode || "").trim() || "00000",
    destinationCityName: String(destination.cityName || "").trim() || "City",
    weight: String(weight),
    length: String(length),
    width: String(width),
    height: String(height),
    plannedShippingDate,
    isCustomsDeclarable: "false",
    unitOfMeasurement: "metric",
    nextBusinessDay: nextBusinessDay ? "true" : "false",
    strictValidation: "false",
    getAllValueAddedServices: "false",
    requestEstimatedDeliveryDate: "true",
    estimatedDeliveryDateType: "QDDF",
  });

  const url = `${baseUrl.replace(/\/$/, "")}/rates?${params}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    const products = data.products;
    if (!Array.isArray(products) || products.length === 0) return [];
    return products
      .map((p) => (p && (p.productCode || p.localProductCode)) || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ——— Request builders ———

function getPlannedShippingDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return {
    date: `${y}-${m}-${day}`,
    dateTime: `${y}-${m}-${day}T12:00:00 GMT+00:00`,
  };
}

function buildReceiver(shipping) {
  const name =
    [shipping.first_name, shipping.last_name].filter(Boolean).join(" ") ||
    shipping.name ||
    "Recipient";
  const address1 = (shipping.address1 || shipping.address_1 || "Address Line 1").slice(0, 45);
  const city = shipping.city || "City";
  const countryCode = (shipping.country_code || shipping.country || "US")
    .toString()
    .substring(0, 2)
    .toUpperCase();
  let postalCode = formatPostalCode(
    shipping.zip || shipping.postal_code || shipping.postal_code_zip || "",
    countryCode
  );
  if (postalCode == null || postalCode === "") {
    if (countryCode === "GB" || countryCode === "UK") {
      const raw =
        shipping.zip ||
        shipping.postal_code ||
        shipping.postal_code_zip ||
        "(empty)";
      throw new Error(
        `Invalid GB postcode. DHL requires UK format (e.g. SW1A 1AA). Order postcode: ${raw}. Fix the shipping address in the order.`
      );
    }
    postalCode = "00000";
  }
  const phone = shipping.phone || "0000000000";

  return {
    postalAddress: {
      addressLine1: address1,
      cityName: city,
      postalCode,
      countryCode,
    },
    contactInformation: {
      companyName: name || "Recipient",
      fullName: name,
      phone: phone || "0000000000",
    },
  };
}

function buildShipper(company, receiverCountryCode) {
  const companyCountry = company?.country_code || company?.address?.country_code;
  const countryCode = companyCountry
    ? String(companyCountry).substring(0, 2).toUpperCase()
    : "";
  const hasCompanyAddress = Boolean(countryCode);
  const originCountry = hasCompanyAddress ? countryCode : receiverCountryCode;

  let postalCode = placeholderPostalCode(originCountry);
  if (hasCompanyAddress && (company?.postal_code || company?.address?.postal_code)) {
    const raw = company.postal_code || company.address.postal_code;
    const formatted = formatPostalCode(raw, originCountry);
    postalCode = formatted != null ? formatted : String(raw).trim();
  }

  const address1 =
    hasCompanyAddress && (company?.address1 || company?.address?.address1)
      ? String(company.address1 || company.address.address1).slice(0, 45)
      : "Shipper Street";
  const cityName =
    hasCompanyAddress && (company?.city || company?.address?.city)
      ? (company.city || company.address.city).trim()
      : placeholderCity(originCountry);

  return {
    postalAddress: {
      addressLine1: address1,
      cityName: cityName || placeholderCity(originCountry),
      postalCode,
      countryCode: originCountry,
    },
    contactInformation: {
      companyName: "Shipper",
      fullName: "Shipper",
      phone: "0000000000",
    },
  };
}

function buildShipmentBody({
  productCode,
  accounts,
  shipper,
  receiver,
  packages,
  plannedShippingDateAndTime,
}) {
  return {
    plannedShippingDateAndTime,
    productCode,
    accounts,
    pickup: { isRequested: false },
    customerDetails: { shipperDetails: shipper, receiverDetails: receiver },
    content: {
      packages,
      description: "Goods",
      unitOfMeasurement: "metric",
      isCustomsDeclarable: false,
      declaredValue: 0,
      declaredValueCurrency: "USD",
    },
  };
}

// ——— Error parsing ———

function parseDhlErrorResponse(data) {
  const parts = [];
  const push = (s) => s && typeof s === "string" && parts.push(s.trim());

  push(data.detail || data.message || data.title || data.statusText);

  const errorLists = [
    data.errors,
    data.result?.warnings,
    data.validationErrors,
    data.result?.messages,
    data.invalidParams,
  ].filter(Boolean);
  for (const list of errorLists) {
    const arr = Array.isArray(list) ? list : [list];
    for (const e of arr) {
      if (typeof e === "string") push(e);
      else if (e && typeof e === "object")
        push(
          e.message ||
            e.msg ||
            e.detail ||
            e.code ||
            e.reason ||
            (e.property && e.message ? `${e.property}: ${e.message}` : null) ||
            (e.param && e.msg ? `${e.param}: ${e.msg}` : null)
        );
    }
  }

  if (Array.isArray(data.result?.messages)) {
    for (const m of data.result.messages) {
      if (typeof m === "string") push(m);
      else if (m && typeof m === "object")
        push(m.message || m.code || m.detail || m.msg);
    }
  }
  if (Array.isArray(data.additionalDetails)) {
    for (const a of data.additionalDetails) if (typeof a === "string") push(a);
  }

  return parts.length ? parts.join(". ") : "";
}

function errorDetailIncludes(detail, codes) {
  const list = Array.isArray(codes) ? codes : [codes];
  return list.some((code) => detail.includes(code));
}

// Country code -> DHL tracking page locale (for regional Track & Trace)
const TRACKING_LOCALES = {
  PK: "pk-en",
  AE: "ae-en",
  IN: "in-en",
  SA: "sa-en",
};

// ——— Label extraction ———

/**
 * Get tracking number from DHL create-shipment response.
 * Prefer shipment-level AWB; fallback to first piece (some APIs return only piece-level).
 * Note: DHL test base URL (/test) returns numbers that may not work on public Track & Trace; use production for real shipments.
 */
function getTrackingNumber(data) {
  const main = data.shipmentTrackingNumber;
  if (main) return main;
  const firstPiece = data.pieces?.[0]?.trackingNumber;
  if (firstPiece) return firstPiece;
  return null;
}

function buildTrackingUrl(trackingNumber, receiverCountryCode) {
  const locale = receiverCountryCode ? TRACKING_LOCALES[receiverCountryCode.toUpperCase()] : null;
  if (locale) {
    return `https://www.dhl.com/${locale}/home/tracking.html?tracking-id=${encodeURIComponent(trackingNumber)}`;
  }
  return `${TRACKING_BASE_URL}?AWB=${encodeURIComponent(trackingNumber)}`;
}

function extractLabelAndTracking(data, receiverCountryCode = null) {
  const trackingNumber = getTrackingNumber(data);
  if (!trackingNumber) return null;

  let labelUrl = null;
  const documents = data.documents || [];
  const waybill = documents.find(
    (d) => d.typeCode === "waybillDoc" || (d.imageFormat && d.content)
  );
  if (waybill?.content) {
    labelUrl = `data:${waybill.imageFormat || "application/pdf"};base64,${waybill.content}`;
  }
  if (!labelUrl && documents[0]?.url) {
    labelUrl = documents[0].url;
  }

  const trackingUrl = buildTrackingUrl(trackingNumber, receiverCountryCode);
  return {
    trackingNumber,
    labelUrl: labelUrl || trackingUrl,
    trackingUrl,
  };
}

// ——— Public API ———

export class DHLIntegration {
  static slug = "dhl";

  /**
   * Create a shipment and return tracking and label URL.
   * @param {object} credentials - DHL API credentials (username, password, account_number, base_url)
   * @param {object} order - Order document (must have shipping address)
   * @param {string} serviceCode - e.g. "express", "economy", "P", "N"
   * @param {object|null} company - Order’s company; if it has address, used as shipper (origin)
   * @returns {Promise<{ trackingNumber: string, labelUrl: string, trackingUrl: string }>}
   */
  static async createShipment(credentials, order, serviceCode, company = null) {
    const { username, password, accountNumber, baseUrl } =
      normalizeCredentials(credentials);

    if (!username || !password) {
      throw new Error(
        "DHL credentials missing: username and password (or api_key and api_secret) required"
      );
    }
    if (!accountNumber) {
      throw new Error(
        "DHL requires a valid shipper account number (error 801). Add 'Shipper account number' in your DHL carrier integration."
      );
    }

    const shipping = getShippingFromOrder(order);
    const receiver = buildReceiver(shipping);
    const receiverCountryCode = receiver.postalAddress.countryCode;

    const shipper = buildShipper(company, receiverCountryCode);
    const { date: plannedShippingDate, dateTime: plannedShippingDateAndTime } =
      getPlannedShippingDate();

    const auth = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    const ratingOrigin = {
      countryCode: shipper.postalAddress.countryCode,
      postalCode: shipper.postalAddress.postalCode,
      cityName: shipper.postalAddress.cityName,
    };
    const ratingDestination = {
      countryCode: receiver.postalAddress.countryCode,
      postalCode: receiver.postalAddress.postalCode,
      cityName: receiver.postalAddress.cityName,
    };

    let availableProducts = await getAvailableProducts({
      auth,
      baseUrl,
      accountNumber,
      origin: ratingOrigin,
      destination: ratingDestination,
      plannedShippingDate,
      nextBusinessDay: false,
    });
    if (availableProducts.length === 0) {
      availableProducts = await getAvailableProducts({
        auth,
        baseUrl,
        accountNumber,
        origin: ratingOrigin,
        destination: ratingDestination,
        plannedShippingDate,
        nextBusinessDay: true,
      });
    }

    const productsToTry = availableProducts.length > 0 ? availableProducts : ["N", "P", "Y"];
    let chosenProduct = resolveProductCode(serviceCode);
    if (
      shipper.postalAddress.countryCode === receiverCountryCode &&
      chosenProduct === "P"
    ) {
      chosenProduct = "N";
    }
    if (availableProducts.length > 0) {
      chosenProduct = availableProducts.includes(chosenProduct)
        ? chosenProduct
        : availableProducts[0];
    }

    const accounts = [{ typeCode: "shipper", number: accountNumber }];
    const packages = [
      {
        weight: DEFAULT_WEIGHT_KG,
        dimensions: DEFAULT_DIMENSIONS_CM,
      },
    ];

    const buildBody = (productCode) =>
      buildShipmentBody({
        productCode,
        accounts,
        shipper,
        receiver,
        packages,
        plannedShippingDateAndTime,
      });

    const url = `${baseUrl}/shipments`;
    let res;
    let data = {};

    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildBody(chosenProduct)),
      });
      data = await res.json().catch(() => ({}));

      if (res.status === 400) {
        const detail = parseDhlErrorResponse(data);
        if (errorDetailIncludes(detail, DHL_ERROR_CODES.PRODUCT_UNAVAILABLE)) {
          const tried = new Set([chosenProduct]);
          for (const product of productsToTry) {
            if (tried.has(product)) continue;
            tried.add(product);
            const retryRes = await fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(buildBody(product)),
            });
            const retryData = await retryRes.json().catch(() => ({}));
            if (retryRes.ok) {
              res = retryRes;
              data = retryData;
              break;
            }
          }
          if (!res.ok) {
            const retryDetail = parseDhlErrorResponse(data);
            throw new Error(
              `DHL API 400: No product available for this route or account. ${retryDetail} Contact DHL to enable a service for ${shipper.postalAddress.countryCode} or check your contract.`
            );
          }
        }
      }
    } catch (err) {
      if (err.message.startsWith("DHL API 400:")) throw err;
      throw new Error(`DHL API request failed: ${err.message}`);
    }

    if (!res.ok) {
      const detail = parseDhlErrorResponse(data);

      if (res.status === 401) {
        throw new Error(
          "DHL credentials are invalid. Check Username and Password in your DHL carrier integration (developer.dhl.com)."
        );
      }
      if (res.status === 403) {
        throw new Error(
          "DHL access not granted or account not yet active. Check developer.dhl.com or contact DHL support."
        );
      }
      if (res.status === 422) {
        console.warn("[DHL] 422 response:", JSON.stringify(data).slice(0, 2000));
        const hint =
          " Possible causes: (1) request validation – fix the field DHL mentions; (2) credentials/account not yet accepted – allow time or contact DHL.";
        throw new Error(
          detail
            ? `DHL API 422: ${detail}${hint}`
            : `DHL API 422: Unprocessable Entity. Check server logs for [DHL] 422 response.${hint}`
        );
      }
      if (
        res.status === 400 &&
        errorDetailIncludes(detail, DHL_ERROR_CODES.PRODUCT_UNAVAILABLE)
      ) {
        throw new Error(
          `DHL API 400: ${detail} Try the other service (Express/Economy) or contact DHL.`
        );
      }
      if (res.status === 400 && detail.includes(DHL_ERROR_CODES.ORIGIN_INVALID)) {
        throw new Error(
          `DHL API 400: ${detail} Ensure order shipping address (destination) is complete and valid.`
        );
      }
      throw new Error(`DHL API ${res.status}: ${detail || "Request failed"}`);
    }

    const result = extractLabelAndTracking(data, receiverCountryCode);
    if (!result) {
      throw new Error("DHL API returned success but no shipment tracking number");
    }
    return result;
  }
}
