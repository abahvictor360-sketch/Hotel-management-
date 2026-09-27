import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertText,
  internationalNumber,
  leadAlerter,
  readAlertConfig,
  sendLeadAlert,
  templateParameters,
  type Lead,
} from "../apps/api/src/lead-alerts.js";

const lead: Lead = {
  id: "8a0e2c52-5b1f-4c7a-9c1e-2d7d6b0f1a11",
  name: "Chiamaka Eze",
  email: "chiamaka@lekkibay.example",
  phone: "0803 123 4567",
  hotelName: "Lekki Bay Suites",
  city: "Lagos",
  rooms: 32,
  plan: "premium",
  message: "We lose bookings\nwhenever our fibre goes down.",
};
type Call = { url: string; init?: RequestInit };
function fakeFetch(status: number, body: string, calls: Call[]) {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
}

test("phone numbers become international digits", () => {
  assert.equal(internationalNumber("0803 123 4567"), "2348031234567");
  assert.equal(internationalNumber("+234 (803) 123-4567"), "2348031234567");
  assert.equal(internationalNumber("+44 7700 900123"), "447700900123");
});

test("alerts are off until a number and a sender are configured", () => {
  assert.equal(readAlertConfig({}), null);
  assert.equal(readAlertConfig({ LEAD_WHATSAPP_TO: "0803 123 4567" }), null);
  assert.equal(
    readAlertConfig({
      LEAD_WHATSAPP_TO: "0803",
      WHATSAPP_CLOUD_TOKEN: "t",
      WHATSAPP_PHONE_NUMBER_ID: "1",
    }),
    null,
    "Meta needs an approved template",
  );
  assert.equal(
    readAlertConfig({
      LEAD_WHATSAPP_TO: "0803 123 4567",
      CALLMEBOT_API_KEY: "k",
    })?.kind,
    "callmebot",
  );
});

test("the alert text carries what is needed to reply", () => {
  const text = alertText(lead, "https://console.example");
  assert.match(text, /Lekki Bay Suites\* · Lagos · 32 rooms · premium plan/);
  assert.match(text, /0803 123 4567 · chiamaka@lekkibay.example/);
  assert.match(text, /"We lose bookings whenever our fibre goes down\."/);
  assert.match(text, /Reply from https:\/\/console\.example$/);
});

test("template parameters are single-line", () => {
  for (const p of templateParameters({ ...lead, message: "a\n\tb    c" }))
    assert.doesNotMatch(p, /[\n\t]| {4}/);
});

test("CallMeBot is called with the number, text and key", async () => {
  const calls: Call[] = [];
  const config = readAlertConfig({
    LEAD_WHATSAPP_TO: "0803 123 4567",
    CALLMEBOT_API_KEY: "123456",
  })!;
  await sendLeadAlert(
    config,
    lead,
    fakeFetch(
      200,
      "Message queued. You will receive it in a few seconds.",
      calls,
    ),
  );
  const url = new URL(calls[0].url);
  assert.equal(url.host, "api.callmebot.com");
  assert.equal(url.searchParams.get("phone"), "+2348031234567");
  assert.equal(url.searchParams.get("apikey"), "123456");
  assert.match(url.searchParams.get("text")!, /Lekki Bay Suites/);
  await assert.rejects(
    sendLeadAlert(config, lead, fakeFetch(200, "<p>APIKey is invalid</p>", [])),
    /CallMeBot refused/,
  );
});

test("WhatsApp Cloud API sends the approved template", async () => {
  const calls: Call[] = [];
  const config = readAlertConfig({
    LEAD_WHATSAPP_TO: "+234 803 123 4567",
    WHATSAPP_CLOUD_TOKEN: "secret-token",
    WHATSAPP_PHONE_NUMBER_ID: "1098765",
    WHATSAPP_TEMPLATE: "new_enquiry",
  })!;
  await sendLeadAlert(config, lead, fakeFetch(200, "{}", calls));
  assert.equal(
    calls[0].url,
    "https://graph.facebook.com/v21.0/1098765/messages",
  );
  assert.equal(
    (calls[0].init!.headers as Record<string, string>).Authorization,
    "Bearer secret-token",
  );
  const body = JSON.parse(String(calls[0].init!.body));
  assert.equal(body.to, "2348031234567");
  assert.equal(body.template.name, "new_enquiry");
  assert.equal(body.template.language.code, "en");
  assert.equal(body.template.components[0].parameters.length, 4);
  await assert.rejects(
    sendLeadAlert(
      config,
      lead,
      fakeFetch(401, '{"error":{"message":"Invalid OAuth access token"}}', []),
    ),
    /Invalid OAuth access token/,
  );
});

test("a failing alert is logged, never thrown", async () => {
  const alert = leadAlerter(
    { LEAD_WHATSAPP_TO: "0803 123 4567", CALLMEBOT_API_KEY: "k" },
    (async () => {
      throw new Error("network down");
    }) as typeof fetch,
  );
  const errors: string[] = [];
  const original = console.error;
  console.error = (m: string) => errors.push(m);
  try {
    await alert(lead);
  } finally {
    console.error = original;
  }
  assert.match(errors[0], /lead_alert_failed.*network down/);
  assert.doesNotMatch(
    errors[0],
    /Chiamaka|0803|lekkibay/,
    "no personal details in logs",
  );
});
