import type { Response } from "express";
import { z } from "zod";
import {
  reportCsv,
  reportPdf,
  type Report,
} from "../../../packages/core/src/report-format.js";
// Download helpers shared by the hub and the cloud dashboard, so both produce identical files.
// No hub configuration is imported here: the cloud process loads this module too.
export const formatSchema = z.enum(["json", "csv", "pdf"]).default("json");
const safeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "hotel";
export function sendReport(res: Response, report: Report, format: string) {
  const name = `${safeName(report.hotel.name)}-${report.kind}-${report.from}-to-${report.to}`;
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
    return res.send(reportCsv(report));
  }
  if (format === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.pdf"`);
    return res.send(reportPdf(report));
  }
  return res.json(report);
}
export function sendExport(res: Response, name: string, data: Buffer) {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeName(name)}-export-${new Date().toISOString().slice(0, 10)}.zip"`,
  );
  res.send(data);
}
