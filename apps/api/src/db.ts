import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
export const db = new PrismaClient();
export type Tx = Prisma.TransactionClient;
export type Context = {
  tenantId: string;
  userId?: string;
  deviceId?: string;
  writable?: boolean;
};
// All request queries use a transaction-local context. Never use session SET with pooled connections.
export async function scope<T>(
  client: PrismaClient,
  ctx: Context,
  fn: (tx: Tx) => Promise<T>,
  options: {
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  } = {},
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId ?? ""},true),set_config('app.device_id',${ctx.deviceId ?? "hub"},true),set_config('app.can_write',${ctx.writable ? "true" : "false"},true)`;
      return fn(tx);
    },
    { maxWait: 5000, timeout: 15000, ...options },
  );
}
// One call = one changed business row. Triggers require these app-generated UUIDs,
// insert an outbox record and audit row in the same transaction, and reject untracked writes.
export async function mutation<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx.$executeRaw`SELECT set_config('app.event_id',${randomUUID()},true),set_config('app.audit_id',${randomUUID()},true)`;
  return fn();
}
export function base(ctx: Context) {
  return {
    id: randomUUID(),
    tenant_id: ctx.tenantId,
    created_by: ctx.userId ?? null,
    device_id: ctx.deviceId ?? "hub",
  };
}
export async function assertRuntimeRole(
  client: PrismaClient,
  expected: string,
) {
  const rows = await client.$queryRaw<
    { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  if (rows[0]?.rolname !== expected || rows[0].rolsuper || rows[0].rolbypassrls)
    throw new Error(`Unsafe database role: expected non-owner ${expected}`);
  const owned = await client.$queryRaw<
    { count: bigint }[]
  >`SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner=current_user`;
  if (Number(owned[0].count) !== 0)
    throw new Error("Runtime database role must not own tables");
}
