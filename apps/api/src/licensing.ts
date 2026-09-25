import { PrismaClient } from "@prisma/client";
import { env, publicKey } from "./config.js";
import { scope, base } from "./db.js";
import {
  licenseDecision,
  verifyLicense,
  type LicenseClaims,
} from "../../../packages/core/src/license.js";
export const licenseDb = new PrismaClient({
  datasourceUrl: env.LICENSE_DATABASE_URL,
});
export async function getLicense() {
  const record = await scope(licenseDb, { tenantId: env.HOTEL_ID }, (tx) =>
    tx.license_cache.findFirst({
      where: {
        tenant_id: env.HOTEL_ID,
        installation_id: env.INSTALLATION_ID,
        deleted_at: null,
      },
    }),
  );
  let claims: LicenseClaims | null = null;
  try {
    if (record)
      claims = verifyLicense(
        record.signed_token,
        publicKey,
        env.HOTEL_ID,
        env.INSTALLATION_ID,
      );
  } catch {}
  return {
    claims,
    ...licenseDecision(
      claims,
      Date.now(),
      record?.max_observed_at.getTime() ?? 0,
    ),
    lastCheckedAt: record?.last_checked_at ?? null,
  };
}
export async function acceptLicense(token: string) {
  const claims = verifyLicense(
    token,
    publicKey,
    env.HOTEL_ID,
    env.INSTALLATION_ID,
  );
  if (claims.issuedAt > Date.now() + 300_000 || claims.validUntil <= Date.now())
    throw new Error("Stale licence response");
  await scope(licenseDb, { tenantId: env.HOTEL_ID }, async (tx) => {
    const old = await tx.license_cache.findFirst({
      where: { installation_id: env.INSTALLATION_ID },
    });
    if (old && old.last_checked_at.getTime() > claims.issuedAt)
      throw new Error("Licence replay rejected");
    const data = {
      signed_token: token,
      last_checked_at: new Date(claims.issuedAt),
      max_observed_at: new Date(
        Math.max(Date.now(), old?.max_observed_at.getTime() ?? 0),
      ),
    };
    if (old) await tx.license_cache.update({ where: { id: old.id }, data });
    else
      await tx.license_cache.create({
        data: {
          ...base({ tenantId: env.HOTEL_ID }),
          installation_id: env.INSTALLATION_ID,
          ...data,
        },
      });
  });
  return getLicense();
}
export async function refreshLicense(key: string) {
  const response = await fetch(`${env.PROVIDER_URL}/api/license/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key,
      tenantId: env.HOTEL_ID,
      installationId: env.INSTALLATION_ID,
      schemaVersion: 1,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok)
    throw new Error(`Licence server returned ${response.status}`);
  const body = (await response.json()) as { token: string };
  return acceptLicense(body.token);
}
export function startLicenseWorker(key: string) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      // Persist a high-water clock even when cloud is unreachable.
      await scope(licenseDb, { tenantId: env.HOTEL_ID }, async (tx) => {
        const old = await tx.license_cache.findFirst({
          where: { installation_id: env.INSTALLATION_ID },
        });
        if (old && Date.now() > old.max_observed_at.getTime())
          await tx.license_cache.update({
            where: { id: old.id },
            data: { max_observed_at: new Date() },
          });
      });
      if (key) await refreshLicense(key);
    } catch {
      console.warn(
        JSON.stringify({
          event: "license_validation_unavailable",
          tenantId: env.HOTEL_ID,
        }),
      );
    } finally {
      busy = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
