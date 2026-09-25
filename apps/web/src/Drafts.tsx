import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { uuid } from "./ServiceDesk";
type Draft = {
  requestId: string;
  draft: { kind: string; data: Record<string, string> };
};
export function Drafts({
  userId,
  permissions,
}: {
  userId: string;
  permissions: string[];
}) {
  const storageKey = "hotel-drafts-" + userId,
    [local, setLocal] = useState<Draft[]>(() => {
      try {
        return JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      } catch {
        return [];
      }
    }),
    [remote, setRemote] = useState<any[]>([]),
    [error, setError] = useState(""),
    [kind, setKind] = useState(
      permissions.includes("frontdesk.write")
        ? "guest"
        : permissions.includes("housekeeping.write")
          ? "housekeeping"
          : "order",
    ),
    [version, setVersion] = useState(0);
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(local));
  }, [local, storageKey]);
  useEffect(() => {
    let active = true,
      running = false;
    async function flush() {
      if (running) return;
      running = true;
      try {
        for (const draft of local) {
          await api("/drafts", { method: "POST", body: JSON.stringify(draft) });
          if (active)
            setLocal((old) =>
              old.filter((d) => d.requestId !== draft.requestId),
            );
        }
        const rows = await api<any[]>("/drafts");
        if (active) {
          setRemote(rows);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        running = false;
      }
    }
    void flush();
    const timer = setInterval(() => void flush(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [local, version]);
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (local.length >= 100) {
      setError("Submit or remove existing drafts before adding more.");
      return;
    }
    const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<
      string,
      string
    >;
    let data: Record<string, string> = {};
    if (kind === "guest")
      data = { fullName: v.fullName, ...(v.phone ? { phone: v.phone } : {}) };
    if (kind === "note")
      data = { reservationId: v.recordId, notes: v.description };
    if (kind === "housekeeping")
      data = { taskId: v.recordId, notes: v.description };
    if (kind === "order")
      data = { department: v.department, description: v.description };
    const next = [...local, { requestId: uuid(), draft: { kind, data } }];
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setLocal(next);
      e.currentTarget.reset();
      setError("");
    } catch {
      setError(
        "This browser could not save the draft. Free storage space and retry.",
      );
    }
  }
  async function review(id: string, discard: boolean) {
    try {
      await api("/drafts/" + id + "/review", {
        method: "POST",
        body: JSON.stringify({ requestId: uuid(), discard }),
      });
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const canFront = permissions.includes("frontdesk.write"),
    canHouse = permissions.includes("housekeeping.write"),
    departments = ["restaurant", "bar", "laundry", "room_service"].filter(
      (d) =>
        permissions.includes("services." + d) ||
        permissions.includes("billing.write"),
    );
  return (
    <section className="panel">
      <h2>Drafts</h2>
      <p>
        Drafts save on this device and submit to your hub when the connection
        returns. They do not take payments, allocate rooms, change room
        availability or issue receipts.
      </p>
      <p role="status">
        {local.length} unsynced drafts · {remote.length} awaiting review on the
        hub
      </p>
      {error && <p className="notice">{error}</p>}
      <form onSubmit={save}>
        <label>
          Draft type
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {canFront && (
              <>
                <option value="guest">Guest details</option>
                <option value="note">Reservation note</option>
              </>
            )}
            {canHouse && (
              <option value="housekeeping">Housekeeping update</option>
            )}
            {departments.length > 0 && (
              <option value="order">Order request</option>
            )}
          </select>
        </label>
        {kind === "guest" ? (
          <>
            <label>
              Guest name
              <input name="fullName" required minLength={2} maxLength={150} />
            </label>
            <label>
              Phone
              <input name="phone" maxLength={40} />
            </label>
          </>
        ) : (
          <>
            {kind === "order" ? (
              <label>
                Department
                <select name="department">
                  {departments.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                {kind === "note" ? "Reservation" : "Task"} reference
                <input
                  name="recordId"
                  required
                  placeholder="Reference from the record details"
                />
              </label>
            )}
            <label>
              {kind === "order" ? "Items and quantities" : "Update or note"}
              <textarea
                name="description"
                required
                maxLength={kind === "housekeeping" ? 1000 : 2000}
              />
            </label>
          </>
        )}
        <button>Save unsynced draft</button>
      </form>
      {local.map((d) => (
        <article className="card" key={d.requestId}>
          <h3>{d.draft.kind} · Unsynced</h3>
          <p>{Object.values(d.draft.data).join(" · ")}</p>
          <button
            className="secondary"
            onClick={() =>
              setLocal((old) => old.filter((x) => x.requestId !== d.requestId))
            }
          >
            Remove local draft
          </button>
        </article>
      ))}
      {remote.map((d) => (
        <article className="card" key={d.id}>
          <h3>{d.kind} · Awaiting review</h3>
          <p>{Object.values(d.payload).join(" · ")}</p>
          {d.kind === "order" ? (
            <p>
              Create and confirm the priced order in Services, then archive this
              request.
            </p>
          ) : (
            <button onClick={() => void review(d.id, false)}>
              Review and apply
            </button>
          )}
          <button className="secondary" onClick={() => void review(d.id, true)}>
            Archive draft
          </button>
        </article>
      ))}
    </section>
  );
}
