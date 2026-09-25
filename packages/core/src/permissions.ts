export const permissions = [
  "staff.read",
  "staff.write",
  "roles.read",
  "roles.write",
  "devices.read",
  "devices.write",
  "settings.read",
  "settings.write",
  "frontdesk.read",
  "frontdesk.write",
  "billing.read",
  "billing.write",
  "services.restaurant",
  "services.bar",
  "services.laundry",
  "services.room_service",
  "housekeeping.read",
  "housekeeping.write",
  "inventory.read",
  "inventory.write",
  "reports.read",
  "audit.read",
  "sync.manage",
] as const;
export const seededRoles: Record<string, string[]> = {
  admin: [...permissions],
  manager: permissions.filter(
    (p) => !["audit.read", "roles.write", "staff.write"].includes(p),
  ),
  receptionist: [
    "frontdesk.read",
    "frontdesk.write",
    "billing.read",
    "billing.write",
    "housekeeping.read",
  ],
  restaurant: ["services.restaurant", "inventory.read"],
  bar: ["services.bar", "inventory.read"],
  laundry: ["services.laundry", "inventory.read"],
  housekeeping: ["housekeeping.read", "housekeeping.write"],
  accountant: ["billing.read", "reports.read"],
};
export const plans = {
  standard: {
    maxDevices: 8,
    maxRooms: 50,
    features: {
      online_booking: false,
      mobile_dashboard: false,
      provider_credit: true,
    },
  },
  premium: {
    maxDevices: 25,
    maxRooms: 200,
    features: {
      online_booking: true,
      mobile_dashboard: true,
      provider_credit: false,
    },
  },
};
