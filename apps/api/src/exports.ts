import { createHash } from "node:crypto";
import pg from "pg";
import {
  replicatedTables,
  DATABASE_REVISION,
} from "../../../packages/core/src/sync-contract.js";
import { tableCsv, zip } from "../../../packages/core/src/report-format.js";
import type { Query } from "./reports.js";
// Tenant departure export: every business record the hotel owns, one CSV per table, plus a
// manifest with row counts and SHA-256 checksums. Runs on the hub (complete, includes the
// audit trail) or from the cloud copy (replicated tables only) when the hub is gone.
// Table names come from this fixed list and column names from the catalogue. Never input.
export const exportTables = [
  "tenants",
  ...replicatedTables,
  "audit_log",
] as const;
// Never exported, whichever role reads: credentials and secrets are not hotel records.
const excluded: Record<string, string[]> = {
  users: ["password_hash", "token_version"],
};
const PAGE = 5000;
export async function tenantExport(q: Query, source: "hub" | "cloud") {
  const files: { name: string; data: Buffer }[] = [],
    tables: { table: string; file: string; rows: number; sha256: string }[] =
      [],
    unavailable: string[] = [];
  const [hotel] = await q(
    "SELECT id::text AS id,name,slug FROM tenants WHERE id=public.context_tenant()",
  );
  if (!hotel)
    throw new Error("Hotel profile is not available in this database.");
  for (const table of exportTables) {
    // information_schema only lists columns this role may read, so the cloud reader's
    // column grants decide what a cloud export contains.
    const cols = (
      await q(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
        [table],
      )
    )
      .map((r) => r.column_name as string)
      .filter((c) => !(excluded[table] ?? []).includes(c));
    if (!cols.length) {
      unavailable.push(table);
      continue;
    }
    const select = cols
      .map(
        (c) => `${pg.escapeIdentifier(c)}::text AS ${pg.escapeIdentifier(c)}`,
      )
      .join(",");
    const order = cols.includes("created_at") ? "created_at,id" : "id";
    const rows: Record<string, any>[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await q(
        `SELECT ${select} FROM ${pg.escapeIdentifier(table)} ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}`,
      );
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    const data = Buffer.from(
      `${tableCsv({ columns: cols.map((c) => ({ key: c, label: c })), rows })}\r\n`,
      "utf8",
    );
    const file = `data/${table}.csv`;
    files.push({ name: file, data });
    tables.push({
      table,
      file,
      rows: rows.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  const generatedAt = new Date().toISOString();
  const manifest = {
    format: "hotel-hub-tenant-export",
    version: 1,
    tenantId: hotel.id,
    hotel: hotel.name,
    source,
    databaseRevision: DATABASE_REVISION,
    generatedAt,
    tables,
    unavailable,
    omitted: {
      "users.password_hash": "Login secrets are never exported.",
      gateway_credentials: "Encrypted payment gateway keys stay on the hub.",
      "sessions, licence cache, drafts, print jobs, sync queue":
        "Local control records, not hotel business data.",
    },
  };
  files.unshift(
    {
      name: "manifest.json",
      data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    },
    {
      name: "README.txt",
      data: Buffer.from(
        [
          `Hotel Hub data export for ${hotel.name}`,
          `Generated ${generatedAt} from the ${source} copy.`,
          "",
          "Each file in data/ is one table as UTF-8 CSV with a header row.",
          "Amounts are exact decimal text. Times are ISO timestamps with a UTC offset.",
          "JSON columns (receipts, price snapshots, settings) are JSON text.",
          "manifest.json lists every file with its row count and SHA-256 checksum.",
          source === "cloud"
            ? "This export was taken from the cloud copy. It holds what the hub had synced; the audit trail stays on the hub."
            : "This export was taken from the hub and includes the audit trail.",
          "",
        ].join("\r\n"),
        "utf8",
      ),
    },
  );
  return { zip: zip(files), manifest };
}
