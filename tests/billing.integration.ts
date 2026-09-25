import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  signLicense,
  GRACE_MS,
  type LicenseClaims,
} from "../packages/core/src/license.js";
import { db, scope, base, mutation } from "../apps/api/src/db.js";
import { acceptLicense, licenseDb } from "../apps/api/src/licensing.js";
import { app } from "../apps/api/src/app.js";
import { printNext } from "../apps/api/src/printing.js";
const owner = new PrismaClient({
  datasourceUrl: process.env.MIGRATION_DATABASE_URL,
});
const tenantId = process.env.HOTEL_ID!,
  key = readFileSync(process.env.LICENSE_PRIVATE_KEY_FILE!, "utf8");
test("billing transactions: split payments, no oversell, reversal, receipt numbering, printing uncertainty and shift variance", async () => {
  try {
    const claims: LicenseClaims = {
      tenantId,
      installationId: process.env.INSTALLATION_ID!,
      licenseId: randomUUID(),
      status: "active",
      plan: "standard",
      maxDevices: 20,
      maxRooms: 50,
      features: { provider_credit: false },
      issuedAt: Date.now(),
      validUntil: Date.now() + GRACE_MS,
      trialEndsAt: null,
      schemaVersion: 1,
    };
    await acceptLicense(signLicense(claims, key));
    const login = await request(app)
      .post("/api/auth/login")
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: "Changed-password-2026!",
      });
    assert.equal(login.status, 200);
    const headers = { Authorization: `Bearer ${login.body.accessToken}` };
    const get = (p: string) =>
      request(app)
        .get("/api" + p)
        .set(headers);
    const post = (p: string, data: Record<string, unknown> = {}) =>
      request(app)
        .post("/api" + p)
        .set(headers)
        .send({ requestId: randomUUID(), ...data });
    const catalog = (await get("/services/catalog")).body,
      category = catalog.categories.find(
        (c: { name: string }) => c.name === "bar",
      );
    const stock = await post("/inventory", {
      name: "Test bottled drink",
      unit: "bottle",
      category: "bar",
      reorderLevel: "1",
    });
    assert.equal(stock.status, 201);
    assert.equal(
      (
        await post("/inventory/" + stock.body.id + "/adjust", {
          change: "2",
          reason: "Initial stock",
        })
      ).status,
      200,
    );
    const item = await post("/services/items", {
      categoryId: category.id,
      name: "Test drink",
      price: "1000.00",
      unit: "bottle",
      inventoryItemId: stock.body.id,
      stockPerUnit: "1",
    });
    assert.equal(item.status, 201);
    const sale = {
      requestId: randomUUID(),
      categoryId: category.id,
      items: [{ itemId: item.body.id, quantity: "1" }],
      expectedTotal: "1175.00",
      payments: [
        { method: "cash", amount: "500.00" },
        { method: "pos", amount: "675.00", reference: "Terminal-123" },
      ],
    };
    assert.equal(
      (await post("/services/orders", sale)).status,
      409,
      "Shift required, failed order rolls back",
    );
    assert.equal(
      await owner.service_orders.count({
        where: { tenant_id: tenantId, idempotency_key: sale.requestId },
      }),
      0,
    );
    assert.equal(
      (await post("/billing/shift/open", { openingFloat: "10000.00" })).status,
      201,
    );
    const order = await post("/services/orders", sale);
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(order.body.receipt.payload.paid, "1175.00");
    assert.equal(order.body.receipt.payload.hotel.providerCredit, false);
    assert.equal(
      (await post("/services/orders", sale)).body.order.id,
      order.body.order.id,
    );
    assert.equal(
      (await post("/services/orders", { ...sale, expectedTotal: "1000.00" }))
        .status,
      409,
    );
    assert.equal(
      (
        await owner.inventory_items.findUniqueOrThrow({
          where: { id: stock.body.id },
        })
      ).quantity_on_hand.toFixed(3),
      "1.000",
    );
    const raced = await Promise.all([
      post("/services/orders", { ...sale, requestId: randomUUID() }),
      post("/services/orders", { ...sale, requestId: randomUUID() }),
    ]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [201, 409]);
    assert.equal(
      (
        await owner.inventory_items.findUniqueOrThrow({
          where: { id: stock.body.id },
        })
      ).quantity_on_hand.toFixed(3),
      "0.000",
    );
    const other = raced.find((r) => r.status === 201)!.body;
    assert.notEqual(
      other.receipt.receipt_number,
      order.body.receipt.receipt_number,
    );
    const before = await owner.receipts.findUniqueOrThrow({
      where: { id: order.body.receipt.id },
    });
    const voided = await post(
      "/services/orders/" + order.body.order.id + "/void",
      { reason: "Customer returned sealed drink", restock: true },
    );
    assert.equal(voided.status, 200, JSON.stringify(voided.body));
    assert.equal(voided.body.refunds[0].payload.paid, "-1175.00");
    assert.equal(voided.body.refunds[0].reversal_of_id, order.body.receipt.id);
    assert.deepEqual(
      (await owner.receipts.findUniqueOrThrow({ where: { id: before.id } }))
        .payload,
      before.payload,
      "Original receipt content remains unchanged",
    );
    assert.equal(
      (
        await post("/services/orders/" + order.body.order.id + "/void", {
          reason: "Duplicate refund",
          restock: true,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await owner.inventory_items.findUniqueOrThrow({
          where: { id: stock.body.id },
        })
      ).quantity_on_hand.toFixed(3),
      "1.000",
    );
    const cfg = await request(app)
      .put("/api/printing/config")
      .set(headers)
      .send({
        requestId: randomUUID(),
        config: {
          type: "network",
          interface: "tcp://192.168.1.50:9100",
          width: "80",
          characterSet: "PC437_USA",
        },
      });
    assert.equal(cfg.status, 200);
    const print = await post("/printing/receipts/" + other.receipt.id, {
      reason: "Customer original",
    });
    assert.equal(print.status, 202);
    assert.equal(
      (
        await post("/printing/receipts/" + other.receipt.id, {
          reason: "Repeated print click",
        })
      ).body.id,
      print.body.id,
    );
    let sent = 0;
    assert.equal(
      await printNext(async (bytes) => {
        assert.ok(bytes.includes(Buffer.from("1175.00")));
        sent++;
      }),
      true,
    );
    assert.equal(sent, 1);
    assert.equal(
      await printNext(async () => {
        sent++;
      }),
      false,
    );
    const reprint = await post("/printing/receipts/" + other.receipt.id, {
      reason: "Lost customer copy",
      reprint: true,
    });
    assert.equal(reprint.status, 202);
    await printNext(async () => {
      throw new Error("Connection lost after write");
    });
    assert.equal(
      (
        await owner.print_jobs.findUniqueOrThrow({
          where: { id: reprint.body.id },
        })
      ).status,
      "uncertain",
    );
    assert.equal(
      await printNext(async () => {
        sent++;
      }),
      false,
    );
    assert.equal(
      (await get("/billing/receipts/" + other.receipt.id)).body.reprint_count,
      0,
    );
    await post("/printing/receipts/" + other.receipt.id, {
      reason: "Paper checked, copy required",
      reprint: true,
    });
    await printNext(async () => {});
    assert.equal(
      (await get("/billing/receipts/" + other.receipt.id)).body.reprint_count,
      1,
    );
    const foreign = await owner.tenants.findFirstOrThrow({
      where: { id: { not: tenantId } },
    });
    const foreignItem = await scope(
      owner,
      { tenantId: foreign.id, writable: true },
      async (tx) => {
        const category = await mutation(tx, () =>
          tx.service_categories.create({
            data: { ...base({ tenantId: foreign.id }), name: "bar" },
          }),
        );
        return mutation(tx, () =>
          tx.service_items.create({
            data: {
              ...base({ tenantId: foreign.id }),
              category_id: category.id,
              name: "Foreign item",
              price: "1",
              unit: "each",
            },
          }),
        );
      },
    );
    assert.equal(
      (
        await post("/services/orders", {
          ...sale,
          requestId: randomUUID(),
          items: [{ itemId: foreignItem.id, quantity: "1" }],
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await post("/services/orders", {
          ...sale,
          requestId: randomUUID(),
          tenant_id: foreign.id,
        })
      ).status,
      400,
    );
    const config = (await get("/frontdesk/config")).body;
    const room = (await get("/rooms?pageSize=100")).body.items.find(
      (r: { status: string; room_type_id: string }) =>
        r.status === "available" &&
        r.room_type_id ===
          config.roomTypes.find((t: { name: string }) => t.name === "Standard")
            .id,
    );
    const tomorrow = new Date(
      new Date(config.today + "T00:00:00Z").getTime() + 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const stay = await post("/walk-ins", {
      guest: { fullName: "Billing guest" },
      roomTypeId: room.room_type_id,
      roomId: room.id,
      checkInDate: config.today,
      checkOutDate: tomorrow,
      adults: 1,
      children: 0,
    });
    assert.equal(stay.status, 201);
    const folioId = stay.body.folioId;
    const roomOrder = await post("/services/orders", {
      ...sale,
      requestId: randomUUID(),
      folioId,
      payments: [],
    });
    assert.equal(roomOrder.status, 201);
    assert.equal(roomOrder.body.receipt, null);
    assert.equal(
      (
        await post("/services/orders/" + roomOrder.body.order.id + "/void", {
          reason: "Wrong room posting",
          restock: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post("/billing/folios/" + folioId + "/charge", {
          description: "Goodwill discount",
          amount: "100.00",
          discount: true,
        })
      ).status,
      201,
    );
    const invoice = await get("/billing/folios/" + folioId + "/invoice");
    assert.equal(invoice.status, 200);
    assert.equal(invoice.body.total, "41025.00");
    assert.equal(
      (
        await post("/billing/folios/" + folioId + "/pay", {
          payments: [{ method: "online", amount: "41025.00" }],
        })
      ).status,
      400,
      "Online callbacks cannot create manual gateway payments",
    );
    const payment = {
      requestId: randomUUID(),
      payments: [{ method: "cash", amount: "41025.00" }],
      checkout: true,
    };
    const settled = await post("/billing/folios/" + folioId + "/pay", payment);
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    assert.equal(
      (await post("/billing/folios/" + folioId + "/pay", payment)).body.receipt
        .id,
      settled.body.receipt.id,
    );
    assert.equal((await get("/folios/" + folioId)).body.folio.status, "closed");
    assert.equal(
      (
        await post("/billing/folios/" + folioId + "/charge", {
          description: "Late charge",
          amount: "1",
        })
      ).status,
      409,
    );
    const expected = (await get("/billing/shift")).body.expected;
    assert.equal(expected, "51525.00");
    const closed = await post("/billing/shift/close", {
      closingCash: "51500.00",
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.variance, "-25");
    const repLogin = await request(app)
      .post("/api/auth/login")
      .send({
        email: "reception@example.test",
        password: "Reception-changed-2026!",
      });
    assert.equal(
      (
        await request(app)
          .post("/api/inventory")
          .set("Authorization", `Bearer ${repLogin.body.accessToken}`)
          .send({
            requestId: randomUUID(),
            name: "Denied",
            unit: "each",
            category: "bar",
            reorderLevel: "1",
          })
      ).status,
      403,
    );
    await acceptLicense(
      signLicense(
        {
          ...claims,
          issuedAt: Date.now(),
          validUntil: Date.now() + GRACE_MS,
          status: "suspended",
        },
        key,
      ),
    );
    assert.equal((await get("/billing/receipts")).status, 200);
    assert.equal(
      (await post("/billing/shift/open", { openingFloat: "0" })).status,
      423,
    );
  } finally {
    await Promise.all([
      owner.$disconnect(),
      db.$disconnect(),
      licenseDb.$disconnect(),
    ]);
  }
});
