import { createHmac, timingSafeEqual } from "node:crypto";
import {
  toMinor,
  fromMinor,
  type GatewayName,
} from "../../../packages/core/src/booking.js";
// Payment gateway clients used by the cloud booking website. A payment counts only after
// the gateway's own verify API confirms it: never from the browser redirect, never from
// a webhook body. Webhooks only tell us which reference to verify.
export type Fetcher = typeof fetch;
export class GatewayError extends Error {}
export type Verified = {
  status: "success" | "failed" | "pending";
  amount: string | null;
  currency: string | null;
  paidAt: string | null;
  gatewayId: string | null;
  channel: string | null;
};
export type GatewayClient = {
  name: GatewayName;
  initialize(input: {
    reference: string;
    amount: string;
    currency: string;
    email: string;
    name: string;
    callbackUrl: string;
    metadata: Record<string, string>;
  }): Promise<{ url: string }>;
  verify(reference: string): Promise<Verified>;
  webhookValid(
    headers: Record<string, string | string[] | undefined>,
    raw: Buffer,
  ): boolean;
  webhookReference(body: any): string | null;
};
const header = (
  h: Record<string, string | string[] | undefined>,
  k: string,
) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};
const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
async function call(fetcher: Fetcher, url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new GatewayError(
      "The payment provider could not be reached. Try again.",
    );
  }
  const body = (await res.json().catch(() => null)) as any;
  return { status: res.status, body };
}
export function gatewayClient(
  name: GatewayName,
  secret: { secretKey: string; webhookHash?: string },
  fetcher: Fetcher = fetch,
): GatewayClient {
  const auth = {
    Authorization: `Bearer ${secret.secretKey}`,
    "Content-Type": "application/json",
  };
  if (name === "paystack") {
    const base = "https://api.paystack.co";
    return {
      name,
      async initialize(i) {
        const r = await call(fetcher, `${base}/transaction/initialize`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            email: i.email,
            amount: Number(toMinor(i.amount)),
            currency: i.currency,
            reference: i.reference,
            callback_url: i.callbackUrl,
            metadata: i.metadata,
          }),
        });
        if (
          r.status !== 200 ||
          !r.body?.status ||
          !r.body.data?.authorization_url
        )
          throw new GatewayError(
            "The payment provider refused to start this payment.",
          );
        return { url: String(r.body.data.authorization_url) };
      },
      async verify(reference) {
        const r = await call(
          fetcher,
          `${base}/transaction/verify/${encodeURIComponent(reference)}`,
          {
            headers: auth,
          },
        );
        if (r.status === 404)
          return {
            status: "pending",
            amount: null,
            currency: null,
            paidAt: null,
            gatewayId: null,
            channel: null,
          };
        if (r.status !== 200 || !r.body?.data)
          throw new GatewayError("Payment verification failed. Try again.");
        const d = r.body.data;
        if (d.reference !== reference)
          throw new GatewayError("The provider returned a different payment.");
        return {
          status:
            d.status === "success"
              ? "success"
              : ["failed", "reversed"].includes(d.status)
                ? "failed"
                : "pending",
          amount: Number.isSafeInteger(d.amount) ? fromMinor(d.amount) : null,
          currency: typeof d.currency === "string" ? d.currency : null,
          paidAt: d.paid_at ?? null,
          gatewayId: d.id != null ? String(d.id) : null,
          channel: d.channel ?? null,
        };
      },
      // HMAC-SHA512 of the exact request body, keyed with the secret key.
      webhookValid(headers, raw) {
        const sig = header(headers, "x-paystack-signature") ?? "";
        return (
          !!sig &&
          same(
            createHmac("sha512", secret.secretKey).update(raw).digest("hex"),
            sig,
          )
        );
      },
      webhookReference: (body) =>
        typeof body?.data?.reference === "string" ? body.data.reference : null,
    };
  }
  const base = "https://api.flutterwave.com/v3";
  return {
    name,
    async initialize(i) {
      const r = await call(fetcher, `${base}/payments`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          tx_ref: i.reference,
          amount: Number(i.amount),
          currency: i.currency,
          redirect_url: i.callbackUrl,
          customer: { email: i.email, name: i.name },
          meta: i.metadata,
        }),
      });
      if (
        r.status !== 200 ||
        r.body?.status !== "success" ||
        !r.body.data?.link
      )
        throw new GatewayError(
          "The payment provider refused to start this payment.",
        );
      return { url: String(r.body.data.link) };
    },
    async verify(reference) {
      const r = await call(
        fetcher,
        `${base}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
        {
          headers: auth,
        },
      );
      if (
        r.status === 404 ||
        (r.status === 400 && /no transaction/i.test(r.body?.message ?? ""))
      )
        return {
          status: "pending",
          amount: null,
          currency: null,
          paidAt: null,
          gatewayId: null,
          channel: null,
        };
      if (r.status !== 200 || !r.body?.data)
        throw new GatewayError("Payment verification failed. Try again.");
      const d = r.body.data;
      if (d.tx_ref !== reference)
        throw new GatewayError("The provider returned a different payment.");
      const amount =
        typeof d.amount === "number" && Number.isFinite(d.amount)
          ? d.amount.toFixed(2)
          : null;
      return {
        status:
          d.status === "successful"
            ? "success"
            : d.status === "failed"
              ? "failed"
              : "pending",
        amount,
        currency: typeof d.currency === "string" ? d.currency : null,
        paidAt: d.created_at ?? null,
        gatewayId: d.id != null ? String(d.id) : null,
        channel: d.payment_type ?? null,
      };
    },
    // Flutterwave sends the secret hash configured in its dashboard, unchanged.
    webhookValid(headers) {
      const sig = header(headers, "verif-hash") ?? "";
      return !!secret.webhookHash && !!sig && same(sig, secret.webhookHash);
    },
    webhookReference: (body) =>
      typeof body?.data?.tx_ref === "string" ? body.data.tx_ref : null,
  };
}
// A payment is good only if the provider says so for the exact amount and currency asked.
export function assess(
  expected: { amount: string; currency: string },
  v: Verified,
) {
  if (v.status !== "success") return v.status;
  if (v.currency !== expected.currency || !v.amount) return "mismatch";
  try {
    return toMinor(v.amount) === toMinor(expected.amount)
      ? "success"
      : "mismatch";
  } catch {
    return "mismatch";
  }
}
