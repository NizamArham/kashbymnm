const API_BASE = `http://${window.location.hostname}:4000/api`;

function getToken(): string | null {
  return localStorage.getItem("mm_token");
}

export class ApiRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // no body — fine for some responses
  }

  if (!res.ok) {
    const message = data?.error || `Request failed (${res.status})`;
    // A 401 on an already-authenticated request means the session is
    // gone — bounce to login. A 401 from the login attempt itself is
    // just wrong credentials, not an expired session, so it must NOT
    // trigger this (a hard redirect here would wipe the page before
    // the login form ever gets to show the error).
    if (res.status === 401 && path !== "/auth/login") {
      localStorage.removeItem("mm_token");
      localStorage.removeItem("mm_user");
      window.location.href = "/login";
    }
    throw new ApiRequestError(res.status, message);
  }

  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>("GET", path),
  post: <T,>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T,>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T,>(path: string) => request<T>("DELETE", path),
};

// For endpoints that return a raw file (e.g. a DB backup) instead of
// JSON — the other `request()` helper always parses the body as JSON,
// which would choke on binary content, so this is a separate small path
// that fetches a blob and triggers a normal browser download.
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // no JSON body — keep the generic message
    }
    throw new ApiRequestError(res.status, message);
  }

  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? fallbackName;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
