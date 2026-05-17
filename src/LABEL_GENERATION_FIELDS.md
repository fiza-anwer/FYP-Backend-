# Real-time label generation – fields used

When creating a consignment (real-time label via carrier API, e.g. DHL), the following are used.

## Carrier integration (no address)
- **API credentials**: username, password (or api_key, api_secret)
- **Shipper account number**: payer account for the carrier
- **Base URL** (optional): e.g. DHL test vs production

## Order (destination / ship-to)
- **Shipping address**: `address1`, `city`, `postal_code` (or `zip`), `country_code` (or `country`)
- **Name**: `first_name`, `last_name`, or `name`
- **Phone** (optional): `phone`

Source: `order.raw.shipping_address` or `order.raw.shippingAddress` (from Shopify etc.).

## Company (origin / shipper)
- **Address**: `address1`, `city`, `postal_code`, `country_code`
- Resolved from `order.company_id` → company document.

If the company has no address, origin falls back to the destination country and placeholders (carrier-dependent).

## Package (defaults if not configurable)
- **Weight**: 1 kg
- **Dimensions**: 10×10×10 cm
- **Description**: "Goods"
- **Unit**: metric

## Service
- **Carrier service code**: e.g. `express`, `economy` → mapped to carrier product codes (e.g. P, N).

## Other
- **Planned shipping date**: next day 12:00 UTC.
- **Product**: Chosen from carrier Rating API (origin + destination) or fallback list; retried on “product not available”.

Label output is stored as `consignment.label_url` (data URL or http URL). Print label uses this to open the PDF/image in a new window.
