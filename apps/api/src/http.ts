import type { Request, Response, NextFunction, RequestHandler } from "express";
import { ZodError } from "zod";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const route =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res).catch(next);
  };
export function errors(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (error instanceof ZodError)
    return res
      .status(400)
      .json({
        error: "Invalid input",
        fields: error.issues.map((x) => ({ path: x.path, message: x.message })),
      });
  if (error instanceof HttpError)
    return res.status(error.status).json({ error: error.message });
  const code = (error as { code?: string })?.code;
  if (code === "P2002")
    return res.status(409).json({ error: "This record already exists." });
  if (code === "P2003")
    return res.status(400).json({ error: "Related record is unavailable." });
  if (code === "P2025")
    return res.status(404).json({ error: "Record not found." });
  console.error(
    JSON.stringify({ event: "request_failed", code: code ?? "internal" }),
  );
  return res.status(500).json({ error: "The request could not be completed." });
}
