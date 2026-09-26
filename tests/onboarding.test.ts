import { test } from "node:test";
import assert from "node:assert/strict";
import {
  onboardingStatus,
  parseRoomNumbers,
  readOnboarding,
  PLACEHOLDER_ADDRESS,
  type OnboardingFacts,
} from "../packages/core/src/onboarding.js";
const fresh: OnboardingFacts = {
  address: PLACEHOLDER_ADDRESS,
  phone: "",
  email: "",
  roomTypes: 0,
  rooms: 0,
  staff: 1,
  devices: 1,
  bookingEnabled: false,
};
const none = { reviewed: [], completedAt: null };

test("a new hotel has only its device in place", () => {
  const s = onboardingStatus(fresh, none);
  assert.deepEqual(
    s.steps.filter((x) => x.done).map((x) => x.id),
    ["devices"],
  );
  assert.equal(s.ready, false);
});

test("required steps come from real data, review steps from confirmation", () => {
  const facts = {
    ...fresh,
    address: "12 Marina Road",
    phone: "+234 801 234 5678",
    roomTypes: 2,
    rooms: 7,
  };
  assert.equal(onboardingStatus(facts, none).ready, false, "taxes unconfirmed");
  const s = onboardingStatus(facts, { reviewed: ["taxes"], completedAt: null });
  assert.equal(s.ready, true);
  assert.equal(s.done, 5);
  // Optional steps do not block, and count once skipped or evidenced.
  assert.equal(
    onboardingStatus(
      { ...facts, staff: 3, bookingEnabled: true },
      { reviewed: ["taxes", "printer"], completedAt: null },
    ).done,
    8,
  );
});

test("the placeholder address or missing contact keeps the profile open", () => {
  const withAddress = { ...fresh, address: "12 Marina Road" };
  assert.equal(onboardingStatus(withAddress, none).steps[0].done, false);
  assert.equal(
    onboardingStatus({ ...withAddress, email: "desk@palm.example" }, none)
      .steps[0].done,
    true,
  );
  assert.equal(
    onboardingStatus({ ...fresh, phone: "0801" }, none).steps[0].done,
    false,
  );
});

test("stored progress is read tolerantly", () => {
  assert.deepEqual(readOnboarding(null), none);
  assert.deepEqual(
    readOnboarding({ reviewed: ["taxes", "bogus", 4], completedAt: 7 }),
    { reviewed: ["taxes"], completedAt: null },
  );
});

test("room numbers accept ranges, prefixes and single rooms", () => {
  assert.deepEqual(parseRoomNumbers("101-104, 110"), [
    "101",
    "102",
    "103",
    "104",
    "110",
  ]);
  assert.deepEqual(parseRoomNumbers("G1-G3\nAnnex"), [
    "G1",
    "G2",
    "G3",
    "Annex",
  ]);
  assert.deepEqual(parseRoomNumbers("008-011"), ["008", "009", "010", "011"]);
  assert.deepEqual(parseRoomNumbers(" , "), []);
});

test("room numbers reject mistakes with a clear message", () => {
  assert.throws(() => parseRoomNumbers("110-101"), /low to high/);
  assert.throws(() => parseRoomNumbers("1-500"), /more than 100/);
  assert.throws(() => parseRoomNumbers("101-103, 102"), /listed twice/);
  assert.throws(() => parseRoomNumbers("1-60, 100-160"), /at most 100/);
});
