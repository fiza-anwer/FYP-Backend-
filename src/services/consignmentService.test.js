import test from "node:test";
import assert from "node:assert/strict";
import { resolveRecipientEmail } from "./consignmentService.js";

test("uses a saved order email and tolerates missing or masked email", () => {
  assert.equal(
    resolveRecipientEmail({ email: "saved@example.com" }),
    "saved@example.com"
  );
  assert.equal(resolveRecipientEmail({ email: "" }), "");
  assert.equal(resolveRecipientEmail({ email: "buyer***@example.com" }), "");
});
