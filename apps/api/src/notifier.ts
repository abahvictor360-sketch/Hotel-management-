import { createHmac } from "node:crypto";
import type { Conn } from "./sync-apply.js";
import type { Fetcher } from "./gateways.js";
// Guest messages. Both sides write notification rows; only the cloud, which is online,
// delivers them. Delivery goes to one configurable HTTPS endpoint (an email or SMS
// provider, or a small relay), signed with HMAC-SHA256, so no mail library or SMTP
// credentials live in this codebase.
type Connect = () => Promise<{ conn: Conn; release: () => void }>;
export type Message = {
  id: string;
  channel: string;
  to: string;
  subject: string;
  text: string;
  kind: string;
  reference: string;
  hotel: string;
};
export type Deliver = (m: Message) => Promise<void>;
export const MAX_NOTIFY_ATTEMPTS = 5;
export function webhookDeliver(
  url: string,
  secret: string,
  fetcher: Fetcher = fetch,
): Deliver {
  return async (m) => {
    const body = JSON.stringify(m);
    let res: Response;
    try {
      res = await fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hotel-Hub-Signature": createHmac("sha256", secret)
            .update(body)
            .digest("hex"),
          "Idempotency-Key": m.id,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Message service unreachable.");
    }
    if (!res.ok) throw new Error(`Message service returned ${res.status}.`);
  };
}
// Development only: prints the message instead of sending it.
export const logDeliver: Deliver = async (m) => {
  console.log(
    JSON.stringify({ event: "guest_message", to: m.to, subject: m.subject }),
  );
};
const backoffSeconds = (attempts: number) =>
  Math.min(60 * 2 ** attempts, 6 * 3600);
// One pass over every hotel. Rows are locked with SKIP LOCKED, so two cloud instances
// never send the same message twice.
export async function deliverPending(
  connect: Connect,
  deliver: Deliver,
  limit = 20,
) {
  const { conn, release } = await connect();
  const sent = { sent: 0, failed: 0 };
  try {
    const hotels = (
      await conn.query(
        "SELECT id::text AS id,name FROM tenants WHERE deleted_at IS NULL",
      )
    ).rows;
    for (const h of hotels) {
      await conn.query("BEGIN");
      try {
        await conn.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('app.device_id','web',true),set_config('app.user_id','',true)",
          [h.id],
        );
        const rows = (
          await conn.query(
            `SELECT id::text AS id,channel,destination,payload,attempts FROM notifications
             WHERE status='pending' AND deleted_at IS NULL AND attempts<$1
             AND coalesce((payload->>'nextAttemptAt')::timestamptz,'-infinity')<=now()
             ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
            [MAX_NOTIFY_ATTEMPTS, limit],
          )
        ).rows;
        for (const n of rows) {
          const p = n.payload ?? {};
          let error: string | null = null;
          if (n.channel !== "email" || !n.destination)
            error = "No delivery address.";
          else
            try {
              await deliver({
                id: n.id,
                channel: n.channel,
                to: n.destination,
                subject: String(p.subject ?? ""),
                text: String(p.text ?? ""),
                kind: String(p.kind ?? ""),
                reference: String(p.reference ?? ""),
                hotel: h.name,
              });
            } catch (e) {
              error = String((e as Error).message ?? e).slice(0, 300);
            }
          const attempts = n.attempts + 1;
          const status = !error
            ? "sent"
            : attempts >= MAX_NOTIFY_ATTEMPTS || n.channel !== "email"
              ? "failed"
              : "pending";
          await conn.query(
            "SELECT set_config('app.event_id',gen_random_uuid()::text,true),set_config('app.audit_id',gen_random_uuid()::text,true)",
          );
          await conn.query(
            `UPDATE notifications SET status=$2,attempts=$3,payload=payload||jsonb_build_object('lastError',$4::text,
              'sentAt',CASE WHEN $2='sent' THEN now() END,'nextAttemptAt',CASE WHEN $2='pending' THEN now()+make_interval(secs=>$5) END) WHERE id=$1`,
            [n.id, status, attempts, error, backoffSeconds(attempts)],
          );
          if (status === "sent") sent.sent++;
          else if (status === "failed") sent.failed++;
        }
        await conn.query("COMMIT");
      } catch (e) {
        await conn.query("ROLLBACK").catch(() => {});
        throw e;
      }
    }
  } finally {
    release();
  }
  return sent;
}
export function startNotifier(
  connect: Connect,
  deliver: Deliver,
  everyMs = 15_000,
) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void deliverPending(connect, deliver)
      .catch((e) =>
        console.error(
          JSON.stringify({
            event: "notify_failed",
            error: String(e?.message ?? e),
          }),
        ),
      )
      .finally(() => (running = false));
  };
  const t = setInterval(tick, everyMs);
  tick();
  return () => clearInterval(t);
}
