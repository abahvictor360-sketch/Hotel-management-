import { Router } from "express";
import { z } from "zod";
import { db, scope, base, mutation } from "./db.js";
import { identity, requirePermission } from "./auth.js";
import { route, HttpError } from "./http.js";
import { command } from "./commands.js";
import { guestFields, createGuest } from "./stay-service.js";
export const drafts = Router();
const uuid = z.string().uuid();
const payload = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("guest"), data: z.object(guestFields).strict() })
    .strict(),
  z
    .object({
      kind: z.literal("note"),
      data: z
        .object({ reservationId: uuid, notes: z.string().max(2000) })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("housekeeping"),
      data: z.object({ taskId: uuid, notes: z.string().max(1000) }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("order"),
      data: z
        .object({
          department: z.enum(["restaurant", "bar", "laundry", "room_service"]),
          description: z.string().trim().min(2).max(2000),
        })
        .strict(),
    })
    .strict(),
]);
const permission = (p: z.infer<typeof payload>) =>
  p.kind === "order"
    ? `services.${p.data.department}`
    : p.kind === "housekeeping"
      ? "housekeeping.write"
      : "frontdesk.write";
drafts.post(
  "/drafts",
  route(async (req, res) => {
    const v = z
      .object({ requestId: uuid, draft: payload })
      .strict()
      .parse(req.body);
    const who = await identity(req);
    const p =
      v.draft.kind === "order" && who.permissions.includes("billing.write")
        ? "billing.write"
        : permission(v.draft);
    res
      .status(201)
      .json(
        await command(req, p, v, async (tx, who) =>
          mutation(tx, () =>
            tx.draft_submissions.create({
              data: {
                ...base(who),
                idempotency_key: v.requestId,
                kind: v.draft.kind,
                payload: v.draft.data,
                submitted_by: who.userId,
              },
            }),
          ),
        ),
      );
  }),
);
drafts.get(
  "/drafts",
  route(async (req, res) => {
    const who = await identity(req);
    requirePermission(
      who,
      who.permissions.find(
        (p) =>
          ["frontdesk.write", "housekeeping.write", "billing.write"].includes(
            p,
          ) || p.startsWith("services."),
      ) ?? "frontdesk.write",
    );
    res.json(
      await scope(db, who, (tx) =>
        tx.draft_submissions.findMany({
          where: {
            submitted_by: who.userId,
            deleted_at: null,
            applied_entity_id: null,
          },
          orderBy: { created_at: "asc" },
          take: 100,
        }),
      ),
    );
  }),
);
drafts.post(
  "/drafts/:id/review",
  route(async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z
        .object({ requestId: uuid, discard: z.boolean().default(false) })
        .strict()
        .parse(req.body),
      who = await identity(req);
    const record = await scope(db, who, (tx) =>
      tx.draft_submissions.findFirst({
        where: { id, submitted_by: who.userId, deleted_at: null },
      }),
    );
    if (!record) throw new HttpError(404, "Draft not found.");
    const p = payload.parse({ kind: record.kind, data: record.payload });
    const perm =
      p.kind === "order" && who.permissions.includes("billing.write")
        ? "billing.write"
        : permission(p);
    res.json(
      await command(req, perm, v, async (tx, who) => {
        const current = await tx.draft_submissions.findFirstOrThrow({
          where: { id, submitted_by: who.userId },
        });
        if (current.applied_entity_id || current.deleted_at) return current;
        let entity: string | undefined;
        if (!v.discard) {
          if (p.kind === "guest")
            entity = (await createGuest(tx, who, p.data)).id;
          else if (p.kind === "note") {
            const stay = await tx.reservations.findFirst({
              where: { id: p.data.reservationId, deleted_at: null },
            });
            if (!stay) throw new HttpError(404, "Stay not found.");
            await mutation(tx, () =>
              tx.reservations.update({
                where: { id: stay.id },
                data: {
                  notes: `${stay.notes ?? ""}\n${p.data.notes}`.slice(-4000),
                },
              }),
            );
            entity = stay.id;
          } else if (p.kind === "housekeeping") {
            const task = await tx.housekeeping_tasks.findFirst({
              where: { id: p.data.taskId, deleted_at: null },
            });
            if (!task) throw new HttpError(404, "Task not found.");
            await mutation(tx, () =>
              tx.housekeeping_tasks.update({
                where: { id: task.id },
                data: {
                  notes: `${task.notes ?? ""}\n${p.data.notes}`.slice(-2000),
                },
              }),
            );
            entity = task.id;
          } else
            throw new HttpError(
              409,
              "Review the draft in Services and confirm the priced order there, then archive this draft.",
            );
        }
        return mutation(tx, () =>
          tx.draft_submissions.update({
            where: { id },
            data: v.discard
              ? { deleted_at: new Date() }
              : { applied_entity_id: entity },
          }),
        );
      }),
    );
  }),
);
