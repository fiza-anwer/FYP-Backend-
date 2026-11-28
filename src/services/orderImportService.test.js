import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeShippingAddress,
  normalizeShippingAddress,
} from "./orderImportService.js";

test("normalizes Daraz shipping address fields for the orders API", () => {
  assert.deepEqual(
    normalizeShippingAddress({
      first_name: "Test",
      last_name: "Buyer",
      address1: "Main Road",
      address2: "House 10",
      city: "Karachi",
      post_code: "75500",
      country: "Pakistan",
      phone: "03001234567",
    }),
    {
      address1: "Main Road, House 10",
      city: "Karachi",
      postal_code: "75500",
      country_code: "PK",
      name: "Test Buyer",
      first_name: "Test",
      last_name: "Buyer",
      phone: "03001234567",
    }
  );
});

test("keeps previously imported shipping details when a re-import is partial", () => {
  assert.deepEqual(
    mergeShippingAddress(
      { address1: "Main Road", city: "Karachi", postal_code: "75500", country_code: "PK" },
      { address1: "", city: "", postal_code: "75501", country_code: "" }
    ),
    { address1: "Main Road", city: "Karachi", postal_code: "75501", country_code: "PK" }
  );
});
