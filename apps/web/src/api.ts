let token = "";
let refreshing: Promise<boolean> | null = null;
export function setToken(value: string) {
  token = value;
}
export async function restoreSession() {
  if (!refreshing)
    refreshing = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then(async (res) => {
        if (!res.ok) return false;
        setToken((await res.json()).accessToken);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  return refreshing;
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error(
      "Hub response unavailable. The action may have completed. Reconnect to hotel Wi-Fi and retry the same action to check its saved result.",
    );
  }
  if (
    response.status === 401 &&
    retry &&
    !path.startsWith("/auth/") &&
    (await restoreSession())
  )
    return api(path, options, false);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? "Request failed.");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
// Authenticated file download (reports, exports). Saves with the server's file name.
export async function download(path: string, retry = true): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    throw new Error("Hub response unavailable. Reconnect to hotel Wi-Fi and try again.");
  }
  if (response.status === 401 && retry && (await restoreSession()))
    return download(path, false);
  await saveResponse(response);
}
export async function saveResponse(response: Response) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? "Download failed.");
  }
  const name =
    /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ??
    "download";
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
