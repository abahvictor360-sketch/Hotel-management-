// First-run setup for a new hotel. Each step is judged from the hotel's real data where
// possible; steps that are a matter of review (taxes, printer) count once an administrator
// confirms them. Progress lives in the replicated `onboarding` setting. No dependencies:
// the browser uses this module too.
export const ONBOARDING_SETTING = "onboarding";
export const onboardingSteps = [
  { id: "profile", title: "Hotel profile and branding", required: true },
  { id: "roomTypes", title: "Room types and rates", required: true },
  { id: "rooms", title: "Rooms", required: true },
  { id: "taxes", title: "Taxes and service charge", required: true },
  { id: "staff", title: "Staff accounts", required: false },
  { id: "devices", title: "Devices", required: true },
  { id: "printer", title: "Receipt printer", required: false },
  { id: "booking", title: "Online booking", required: false },
] as const;
export type StepId = (typeof onboardingSteps)[number]["id"];
export const stepIds = onboardingSteps.map((s) => s.id) as [
  StepId,
  ...StepId[],
];
export type OnboardingValue = {
  reviewed: StepId[];
  completedAt: string | null;
};
// Tolerant read of the stored setting; the API validates strictly on write.
export function readOnboarding(value: unknown): OnboardingValue {
  const v = (value ?? {}) as Partial<OnboardingValue>;
  return {
    reviewed: Array.isArray(v.reviewed)
      ? v.reviewed.filter((r): r is StepId => stepIds.includes(r as StepId))
      : [],
    completedAt: typeof v.completedAt === "string" ? v.completedAt : null,
  };
}
// The seed writes this placeholder; a hotel has set its address once it differs.
export const PLACEHOLDER_ADDRESS = "Configure your hotel address";
export type OnboardingFacts = {
  address: string;
  phone: string;
  email: string;
  roomTypes: number;
  rooms: number;
  staff: number;
  devices: number;
  bookingEnabled: boolean;
};
export function onboardingStatus(
  facts: OnboardingFacts,
  value: OnboardingValue,
) {
  const reviewed = new Set(value.reviewed);
  const evidence: Record<StepId, boolean> = {
    profile:
      facts.address.trim() !== "" &&
      facts.address.trim() !== PLACEHOLDER_ADDRESS &&
      (facts.phone.trim() !== "" || facts.email.trim() !== ""),
    roomTypes: facts.roomTypes > 0,
    rooms: facts.rooms > 0,
    taxes: false,
    staff: facts.staff > 1,
    devices: facts.devices > 0,
    printer: false,
    booking: facts.bookingEnabled,
  };
  const steps = onboardingSteps.map((s) => ({
    ...s,
    done: evidence[s.id] || reviewed.has(s.id),
  }));
  const required = steps.filter((s) => s.required);
  return {
    steps,
    done: steps.filter((s) => s.done).length,
    total: steps.length,
    ready: required.every((s) => s.done),
    completedAt: value.completedAt,
  };
}
// Room numbers typed as a list: "101-110, 115, G1-G4, Annex". Ranges keep a shared prefix
// and zero padding ("001-010"). Returns distinct numbers in the order given.
export function parseRoomNumbers(input: string, max = 100): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,\n;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const range = /^([A-Za-z]*)(\d+)\s*[-–]\s*\1?(\d+)$/.exec(part);
    if (range) {
      const [, prefix, a, b] = range;
      const from = Number(a),
        to = Number(b);
      if (to < from)
        throw new Error(`"${part}" counts down; write it low to high.`);
      if (to - from + 1 > max)
        throw new Error(`"${part}" is more than ${max} rooms.`);
      const width = a.length === b.length ? a.length : 0;
      for (let n = from; n <= to; n++)
        out.push(prefix + String(n).padStart(width, "0"));
    } else {
      if (part.length > 20)
        throw new Error(`"${part}" is too long for a room number.`);
      out.push(part);
    }
    if (out.length > max)
      throw new Error(`Add at most ${max} rooms at a time.`);
  }
  const seen = new Set<string>();
  for (const n of out) {
    if (seen.has(n)) throw new Error(`Room ${n} is listed twice.`);
    seen.add(n);
  }
  return out;
}
