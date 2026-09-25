import { test } from "node:test";
import assert from "node:assert/strict";
import { printerSchema, thermalBytes } from "../apps/api/src/printer.js";
import type { ReceiptSnapshot } from "../apps/api/src/billing-service.js";
const snapshot: ReceiptSnapshot = {
  version: 1,
  kind: "payment",
  number: "hub-00000001",
  issuedAt: "2026-09-25T12:00:00Z",
  hotel: {
    name: "Demo Hotel",
    address: "Lagos",
    logoUrl: "",
    currency: "NGN",
    symbol: "₦",
    footer: "Thank you",
    providerCredit: true,
  },
  cashier: "Reception",
  customer: "Guest",
  lines: [
    { description: "Lunch", amount: "1000.00" },
    { description: "VAT", amount: "75.00" },
    { description: "Service", amount: "100.00" },
  ],
  payments: [
    { id: "payment", amount: "1175.00", method: "cash", reference: null },
  ],
  total: "1175.00",
  paid: "1175.00",
  balance: "0.00",
};
test("ESC/POS 80mm and 58mm output includes amounts, copy marker and cut command", async () => {
  for (const width of ["80", "58"]) {
    const config = printerSchema.parse({
      type: "network",
      interface: "tcp://192.168.1.50:9100",
      width,
      characterSet: "PC437_USA",
    });
    const bytes = await thermalBytes(snapshot, config, true);
    assert.ok(bytes.includes(Buffer.from("1175.00")));
    assert.ok(bytes.includes(Buffer.from("COPY / REPRINT")));
    assert.ok(bytes.includes(Buffer.from("Demo Hotel")));
    assert.ok(bytes.includes(Buffer.from([0x1d, 0x56])));
  }
});
test("printer config rejects public addresses, paths and unknown encoding", () => {
  const config = {
    type: "network",
    interface: "tcp://192.168.1.50:9100",
    width: "80",
    characterSet: "PC437_USA",
  };
  for (const patch of [
    { interface: "tcp://8.8.8.8:9100" },
    { type: "usb", interface: "/etc/passwd" },
    { type: "serial", interface: "COM3 & whoami" },
    { characterSet: "invalid" },
  ])
    assert.equal(
      printerSchema.safeParse({ ...config, ...patch }).success,
      false,
    );
});
test("receipt fields cannot inject an ESC/POS drawer command", async () => {
  const config = printerSchema.parse({
    type: "network",
    interface: "tcp://10.0.0.5:9100",
    width: "80",
    characterSet: "PC437_USA",
  });
  const bytes = await thermalBytes(
    { ...snapshot, customer: "Guest\x1bp\x00\x01\x01" },
    config,
  );
  assert.equal(bytes.includes(Buffer.from([0x1b, 0x70, 0, 1, 1])), false);
});
