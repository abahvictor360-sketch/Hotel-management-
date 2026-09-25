import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isoDate,
  stayDates,
  hotelToday,
  priceStay,
  nightsBetween,
} from "../packages/core/src/stays.js";
const tax = {
  vat_enabled: true,
  vat_rate: "7.5",
  service_charge_enabled: true,
  service_charge_rate: "10",
};
test("dates reject impossible calendar days and inverted stays", () => {
  for (const day of ["2026-02-29", "2026-04-31", "2026-13-01", "2000-01-00"])
    assert.equal(isoDate.safeParse(day).success, false);
  assert.equal(isoDate.safeParse("2028-02-29").success, true);
  assert.equal(
    stayDates.safeParse({
      checkInDate: "2026-09-25",
      checkOutDate: "2026-09-25",
    }).success,
    false,
  );
  assert.equal(nightsBetween("2026-12-31", "2027-01-02"), 2);
});
test("hotel-local day does not follow the server UTC day", () => {
  assert.equal(
    hotelToday("Africa/Lagos", new Date("2026-09-25T23:30:00Z")),
    "2026-09-26",
  );
});
test("room quote uses exact decimals and independent category taxes", () => {
  const p = priceStay("35000.00", "2026-09-25", "2026-09-27", tax);
  assert.equal(p.net, "70000.00");
  assert.equal(p.vat, "5250.00");
  assert.equal(p.service, "7000.00");
  assert.equal(p.total, "82250.00");
  const noService = priceStay("35000.00", "2026-09-25", "2026-09-26", {
    ...tax,
    service_charge_enabled: false,
  });
  assert.equal(noService.total, "37625.00");
});
test("half-up rounding, complimentary stays and overflow are explicit", () => {
  assert.equal(priceStay("0.20", "2026-09-25", "2026-09-26", tax).vat, "0.02");
  assert.equal(
    priceStay("0.00", "2026-09-25", "2026-09-26", tax).total,
    "0.00",
  );
  assert.throws(() =>
    priceStay("9999999999.99", "2026-09-25", "2026-09-27", tax),
  );
});
