import { test } from "node:test";
import assert from "node:assert/strict";
import { leadSchema } from "../apps/api/src/leads.js";

const good = {
  name: "Chiamaka Eze",
  email: " Chiamaka@LekkiBay.example ",
  hotelName: "Lekki Bay Suites",
  message: "Could we see a demo this week?",
};

test("a contact form enquiry is normalised", () => {
  const v = leadSchema.parse({
    ...good,
    rooms: "32",
    phone: "",
    plan: "premium",
  });
  assert.equal(v.email, "chiamaka@lekkibay.example");
  assert.equal(v.rooms, 32);
  assert.equal(v.phone, null);
  assert.equal(v.city, null);
  assert.equal(v.plan, "premium");
});

test("enquiries missing essentials or with bad values are refused", () => {
  for (const bad of [
    { ...good, name: "A" },
    { ...good, email: "not-an-email" },
    { ...good, message: "hi" },
    { ...good, rooms: 0 },
    { ...good, rooms: "12.5" },
    { ...good, plan: "gold" },
    { ...good, extra: "field" },
  ])
    assert.equal(leadSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
