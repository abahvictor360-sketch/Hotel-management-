import { Router } from "express";
import { z } from "zod";
import { db, scope, base, mutation } from "./db.js";
import { identity, requirePermission } from "./auth.js";
import { route, HttpError } from "./http.js";
import { command } from "./commands.js";
import { receiptAccess } from "./billing.js";
import { printerSchema, thermalBytes, sendBytes } from "./printer.js";
import type { ReceiptSnapshot } from "./billing-service.js";
import { env } from "./config.js";
export const printing = Router();
printing.get(
  "/printing/config",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.read");
    res.json(
      await scope(
        db,
        who,
        async (tx) =>
          (await tx.settings.findFirst({ where: { key: "printer" } }))?.value ??
          null,
      ),
    );
  }),
);
printing.put(
  "/printing/config",
  route(async (req, res) => {
    const v = z
      .object({ requestId: z.string().uuid(), config: printerSchema })
      .strict()
      .parse(req.body);
    res.json(
      await command(req, "settings.write", v, async (tx, who) => {
        const old = await tx.settings.findFirst({ where: { key: "printer" } });
        return mutation(tx, () =>
          old
            ? tx.settings.update({
                where: { id: old.id },
                data: { value: v.config },
              })
            : tx.settings.create({
                data: { ...base(who), key: "printer", value: v.config },
              }),
        );
      }),
    );
  }),
);
printing.get(
  "/printing/jobs",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(who, "settings.read");
    res.json(
      await scope(db, who, (tx) =>
        tx.print_jobs.findMany({ orderBy: { created_at: "desc" }, take: 100 }),
      ),
    );
  }),
);
printing.post(
  "/printing/test",
  route(async (req, res) => {
    const v = z
      .object({ requestId: z.string().uuid() })
      .strict()
      .parse(req.body);
    res.status(202).json(
      await command(req, "settings.write", v, async (tx, who) => {
        printerSchema.parse(
          (await tx.settings.findFirst({ where: { key: "printer" } }))?.value,
        );
        const job = await tx.print_jobs.create({
          data: { ...base(who), kind: "test", reason: "Admin test receipt" },
        });
        await tx.audit_log.create({
          data: {
            ...base(who),
            action: "print_test_requested",
            entity: "print_jobs",
            entity_id: job.id,
            user_id: who.userId,
            occurred_at: new Date(),
          },
        });
        return job;
      }),
    );
  }),
);
printing.post(
  "/printing/receipts/:id",
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      v = z
        .object({
          requestId: z.string().uuid(),
          reprint: z.boolean().default(false),
          reason: z.string().trim().min(3).max(300),
        })
        .strict()
        .parse(req.body);
    const who = await identity(req);
    const permission = who.permissions.includes("billing.read")
      ? "billing.read"
      : (who.permissions.find((p) => p.startsWith("services.")) ??
        "billing.read");
    res.status(202).json(
      await command(req, permission, v, async (tx, who) => {
        await receiptAccess(tx, who, id);
        printerSchema.parse(
          (await tx.settings.findFirst({ where: { key: "printer" } }))?.value,
        );
        const original = await tx.print_jobs.findFirst({
          where: { receipt_id: id, kind: "original" },
        });
        if (!v.reprint && original) return original;
        if (v.reprint && !original)
          throw new HttpError(409, "Request the original print first.");
        const job = await tx.print_jobs.create({
          data: {
            ...base(who),
            receipt_id: id,
            kind: v.reprint ? "reprint" : "original",
            reason: v.reason,
          },
        });
        await tx.audit_log.create({
          data: {
            ...base(who),
            action: "print_requested",
            entity: "receipts",
            entity_id: id,
            user_id: who.userId,
            after: { jobId: job.id, reprint: v.reprint, reason: v.reason },
            occurred_at: new Date(),
          },
        });
        return job;
      }),
    );
  }),
);
export async function printNext(dispatch: typeof sendBytes = sendBytes) {
  const claimed = await scope(
    db,
    { tenantId: env.HOTEL_ID, writable: true },
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.HOTEL_ID + "-printer"},0))`;
      const job = await tx.print_jobs.findFirst({
        where: { status: "pending" },
        orderBy: { created_at: "asc" },
      });
      if (!job) return null;
      await tx.print_jobs.update({
        where: { id: job.id },
        data: { status: "sending" },
      });
      const config = (
        await tx.settings.findFirst({ where: { key: "printer" } })
      )?.value;
      const tenant = await tx.tenants.findUniqueOrThrow({
        where: { id: env.HOTEL_ID },
      });
      const snapshot = job.receipt_id
        ? (
            await tx.receipts.findFirstOrThrow({
              where: { id: job.receipt_id },
            })
          ).payload
        : {
            version: 1,
            kind: "payment",
            number: "TEST — NOT A RECEIPT",
            issuedAt: new Date().toISOString(),
            hotel: {
              name: tenant.name,
              address: "Printer configuration test",
              logoUrl: "",
              currency: tenant.currency,
              symbol: tenant.currency_symbol,
              footer: "Verify text, paper width and cutter.",
              providerCredit: false,
            },
            cashier: "Administrator",
            customer: "Test only",
            lines: [{ description: "Print test", amount: "0.00" }],
            payments: [],
            total: "0.00",
            paid: "0.00",
            balance: "0.00",
          };
      return { job, config, snapshot };
    },
  );
  if (!claimed) return false;
  let failure: string | undefined;
  try {
    const config = printerSchema.parse(claimed.config);
    await dispatch(
      await thermalBytes(
        claimed.snapshot as unknown as ReceiptSnapshot,
        config,
        claimed.job.kind === "reprint",
      ),
      config,
    );
  } catch (e) {
    failure = (e as Error).message.slice(0, 500);
  }
  await scope(
    db,
    {
      tenantId: env.HOTEL_ID,
      userId: claimed.job.created_by ?? undefined,
      deviceId: claimed.job.device_id,
      writable: true,
    },
    async (tx) => {
      await tx.print_jobs.update({
        where: { id: claimed.job.id },
        data: {
          status: failure ? "uncertain" : "sent",
          error: failure ?? null,
          sent_at: failure ? null : new Date(),
        },
      });
      if (!failure && claimed.job.kind === "reprint")
        await mutation(tx, () =>
          tx.receipt_reprints.create({
            data: {
              ...base({
                tenantId: env.HOTEL_ID,
                userId: claimed.job.created_by!,
                deviceId: claimed.job.device_id,
              }),
              receipt_id: claimed.job.receipt_id!,
              requested_by: claimed.job.created_by!,
              printed_at: new Date(),
              reason: claimed.job.reason,
            },
          }),
        );
      await tx.audit_log.create({
        data: {
          ...base({
            tenantId: env.HOTEL_ID,
            userId: claimed.job.created_by ?? undefined,
            deviceId: claimed.job.device_id,
          }),
          user_id: claimed.job.created_by,
          action: failure ? "print_uncertain" : "print_sent",
          entity: "print_jobs",
          entity_id: claimed.job.id,
          after: { error: failure ?? null },
          occurred_at: new Date(),
        },
      });
    },
  );
  return true;
}
export async function startPrintWorker() {
  await scope(db, { tenantId: env.HOTEL_ID, writable: true }, (tx) =>
    tx.print_jobs.updateMany({
      where: { status: "sending" },
      data: {
        status: "uncertain",
        error:
          "Hub restarted during transfer. Inspect the paper before requesting a reprint.",
      },
    }),
  );
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void printNext()
      .catch(() => console.error("Print worker failed."))
      .finally(() => {
        running = false;
      });
  }, 2000);
  return () => clearInterval(timer);
}
