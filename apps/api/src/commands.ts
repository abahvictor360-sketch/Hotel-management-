import { createHash } from "node:crypto";
import type { Request } from "express";
import { Prisma } from "@prisma/client";
import { identity, requirePermission, type Identity } from "./auth.js";
import { getLicense } from "./licensing.js";
import { db, scope, base, type Tx } from "./db.js";
import { HttpError } from "./http.js";
import type { LicenseClaims } from "../../../packages/core/src/license.js";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export async function command<T>(
  req: Request,
  permission: string,
  input: { requestId: string },
  action: (tx: Tx, who: Identity, license: LicenseClaims) => Promise<T>,
): Promise<T> {
  const who = await identity(req);
  requirePermission(who, permission);
  const hash = createHash("sha256")
    .update(
      JSON.stringify(canonical({ path: req.path, method: req.method, input })),
    )
    .digest("hex");
  return scope(db, { ...who, writable: true }, async (tx) => {
    // One writer per hotel for allocation and quota decisions. RLS + database exclusion
    // constraints still protect records written outside this application path.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${who.tenantId},0))`;
    const old = await tx.hub_commands.findFirst({
      where: { request_id: input.requestId },
    });
    if (old) {
      if (old.request_hash !== hash || old.created_by !== who.userId)
        throw new HttpError(
          409,
          "This request ID already belongs to a different action.",
        );
      return old.response as T;
    }
    const license = await getLicense();
    if (!license.writable || !license.claims)
      throw new HttpError(423, license.reason);
    const result = await action(tx, who, license.claims);
    const json = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
    await tx.hub_commands.create({
      data: {
        ...base(who),
        request_id: input.requestId,
        request_hash: hash,
        response: json,
      },
    });
    return result;
  });
}
