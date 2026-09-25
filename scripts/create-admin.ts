import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db, scope, base, mutation } from "../apps/api/src/db.js";
// Adds an administrator to this hub, or with --reset gives an existing one a new
// temporary password. Runs on the hub with its normal hotel_app connection, so row-level
// security, the audit trail and the outbox apply exactly as for any staff change.
// Usage: npm run create-admin -- --email owner@example.com [--name "Full Name"] [--reset]
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = z
  .object({
    email: z
      .string()
      .email()
      .transform((s) => s.toLowerCase()),
    name: z.string().trim().min(1).max(150),
    reset: z.boolean(),
  })
  .parse({
    email: flag("email"),
    name: flag("name") ?? "Administrator",
    reset: args.includes("--reset"),
  });
const tenantId = z.string().uuid().parse(process.env.HOTEL_ID);
// 20 random characters. Shown once; the hub forces a change at first sign-in.
const temporary = randomBytes(15).toString("base64url");
const hash = await bcrypt.hash(temporary, 12);
const ctx = { tenantId, writable: true, deviceId: "admin-cli" };
try {
  const outcome = await scope(db, ctx, async (tx) => {
    const role = await tx.roles.findFirst({
      where: { name: "admin", deleted_at: null },
    });
    if (!role)
      throw new Error("No admin role on this hub. Run npm run seed first.");
    const existing = await tx.users.findFirst({ where: { email: input.email } });
    if (existing && !input.reset)
      throw new Error(
        `${input.email} already exists. Add --reset to give it a new temporary password.`,
      );
    if (existing) {
      await mutation(tx, () =>
        tx.users.update({
          where: { id: existing.id },
          data: {
            password_hash: hash,
            force_password_change: true,
            is_active: true,
            role_id: role.id,
            deleted_at: null,
            token_version: { increment: 1 },
          },
        }),
      );
      // Signs out every existing session of that account.
      await tx.refresh_sessions.updateMany({
        where: { user_id: existing.id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      return "reset";
    }
    await mutation(tx, () =>
      tx.users.create({
        data: {
          ...base(ctx),
          name: input.name,
          email: input.email,
          password_hash: hash,
          role_id: role.id,
          force_password_change: true,
        },
      }),
    );
    return "created";
  });
  console.log(
    `Administrator ${input.email} ${outcome}.\nTemporary password: ${temporary}\nSign in and set a new password. This password is not stored anywhere else.`,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
