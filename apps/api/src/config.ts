import "dotenv/config";
import { readFileSync } from "node:fs";
import { z } from "zod";
export const env = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().min(1),
    HOTEL_ID: z.string().uuid(),
    INSTALLATION_ID: z.string().uuid(),
    JWT_SECRET: z.string().min(32),
    PORT: z.coerce.number().default(4000),
    APP_ORIGIN: z.string().url().default("http://localhost:5173"),
    LICENSE_PUBLIC_KEY_FILE: z.string(),
    LICENSE_DATABASE_URL: z.string().min(1),
    PROVIDER_URL: z.string().url().default("http://localhost:4001"),
    CREDENTIAL_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
    // Cloud sync is optional: without both values the hub runs fully offline.
    SYNC_DATABASE_URL: z.string().min(1).optional(),
    CLOUD_SYNC_URL: z.string().url().optional(),
    HUB_LICENSE_KEY: z.string().optional(),
  })
  .parse(process.env);
export const publicKey = readFileSync(env.LICENSE_PUBLIC_KEY_FILE, "utf8");
