import type { Fetcher } from "./gateways.js";
// WhatsApp alert to the product owner when a website enquiry arrives. Two senders:
//  - CallMeBot: free, for alerts to your own number. Activate once from your phone.
//  - WhatsApp Cloud API (Meta): the official business API. Messages that start a
//    conversation must use an approved template, so a template name is required.
// Alerts are best effort: a failure is logged and never affects the visitor's enquiry.
export type Lead = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  hotelName: string;
  city: string | null;
  rooms: number | null;
  plan: string | null;
  message: string;
};
type Env = Record<string, string | undefined>;
export type AlertConfig =
  | { kind: "callmebot"; to: string; apiKey: string; consoleUrl: string | null }
  | {
      kind: "meta";
      to: string;
      token: string;
      phoneNumberId: string;
      template: string;
      language: string;
      consoleUrl: string | null;
    };
// International digits only: "+234 803 123 4567" and "0803 123 4567" both become
// 2348031234567 (a leading 0 is read as a Nigerian number).
export function internationalNumber(raw: string) {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("0") ? "234" + digits.slice(1) : digits;
}
export function readAlertConfig(env: Env): AlertConfig | null {
  const to = env.LEAD_WHATSAPP_TO
    ? internationalNumber(env.LEAD_WHATSAPP_TO)
    : "";
  const consoleUrl = env.PROVIDER_CONSOLE_URL || null;
  if (!to) return null;
  if (env.CALLMEBOT_API_KEY)
    return { kind: "callmebot", to, apiKey: env.CALLMEBOT_API_KEY, consoleUrl };
  if (
    env.WHATSAPP_CLOUD_TOKEN &&
    env.WHATSAPP_PHONE_NUMBER_ID &&
    env.WHATSAPP_TEMPLATE
  )
    return {
      kind: "meta",
      to,
      token: env.WHATSAPP_CLOUD_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      template: env.WHATSAPP_TEMPLATE,
      language: env.WHATSAPP_TEMPLATE_LANG || "en",
      consoleUrl,
    };
  return null;
}
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};
export function alertText(lead: Lead, consoleUrl: string | null) {
  const facts = [
    lead.city,
    lead.rooms ? `${lead.rooms} rooms` : null,
    lead.plan && lead.plan !== "unsure" ? `${lead.plan} plan` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    "🏨 New Hotel Hub enquiry",
    `*${oneLine(lead.hotelName, 150)}*${facts ? ` · ${facts}` : ""}`,
    `${oneLine(lead.name, 120)} · ${lead.phone ?? "no phone"} · ${lead.email}`,
    `"${oneLine(lead.message, 500)}"`,
    consoleUrl ? `Reply from ${consoleUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
// Template parameters may not contain line breaks, tabs or long runs of spaces.
export function templateParameters(lead: Lead) {
  const contact = [lead.phone, lead.email].filter(Boolean).join(" / ");
  return [
    oneLine(lead.hotelName, 150),
    oneLine(
      lead.rooms
        ? `${lead.rooms} rooms${lead.city ? `, ${lead.city}` : ""}`
        : lead.city || "Not given",
      120,
    ),
    oneLine(`${lead.name} (${contact})`, 300),
    oneLine(lead.message, 700),
  ];
}
export async function sendLeadAlert(
  config: AlertConfig,
  lead: Lead,
  fetcher: Fetcher = fetch,
) {
  const signal = AbortSignal.timeout(8000);
  if (config.kind === "callmebot") {
    const url = new URL("https://api.callmebot.com/whatsapp.php");
    url.searchParams.set("phone", "+" + config.to);
    url.searchParams.set("text", alertText(lead, config.consoleUrl));
    url.searchParams.set("apikey", config.apiKey);
    const res = await fetcher(url, { signal });
    const body = await res.text();
    // CallMeBot answers 200 with an explanation even when it refuses.
    if (!res.ok || /error|invalid|not activated/i.test(body))
      throw new Error(
        `CallMeBot refused the alert (${res.status}): ${oneLine(body.replace(/<[^>]+>/g, " "), 160)}`,
      );
    return;
  }
  const res = await fetcher(
    `https://graph.facebook.com/v21.0/${encodeURIComponent(config.phoneNumberId)}/messages`,
    {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: config.to,
        type: "template",
        template: {
          name: config.template,
          language: { code: config.language },
          components: [
            {
              type: "body",
              parameters: templateParameters(lead).map((text) => ({
                type: "text",
                text,
              })),
            },
          ],
        },
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(
      `WhatsApp Cloud API refused the alert (${res.status}): ${detail?.error?.message ?? "no detail"}`,
    );
  }
}
// Sends the alert when configured and logs the outcome without personal details.
export function leadAlerter(env: Env, fetcher: Fetcher = fetch) {
  const config = readAlertConfig(env);
  return async (lead: Lead) => {
    if (!config) return;
    try {
      await sendLeadAlert(config, lead, fetcher);
      console.log(
        JSON.stringify({
          event: "lead_alert_sent",
          id: lead.id,
          via: config.kind,
        }),
      );
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "lead_alert_failed",
          id: lead.id,
          via: config.kind,
          error: (e as Error).message,
        }),
      );
    }
  };
}
