export const API = process.env.NEXT_PUBLIC_API_URL ?? "/api/v1";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details: Record<string, unknown>) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const clientErrorId = `WEB-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  if (!headers.has("X-Client-Request-Id")) headers.set("X-Client-Request-Id", clientErrorId);
  if (typeof init?.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiError(`The application backend could not be reached. Please retry.\nError ID: ${clientErrorId}`, 0, { errorId: clientErrorId });
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let data: Record<string, unknown> = {};
    try { data = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { data = {}; }
    const serverMessage = typeof data.message === "string"
      ? data.message
      : Array.isArray(data.message) ? data.message.filter((item): item is string => typeof item === "string").join(". ")
      : typeof data.error === "string" && response.status < 500 ? data.error
      : null;
    const proxyFailure = response.status >= 500 && (raw === "Internal Server Error" || response.status === 502 || response.status === 504);
    const fallback = proxyFailure
      ? "The application backend could not be reached. Please retry."
      : response.status >= 500
      ? "The server could not complete the request. No error details were returned."
      : `Request failed (${response.status})`;
    const errorId = typeof data.errorId === "string" ? data.errorId : proxyFailure ? clientErrorId : null;
    const message = serverMessage || fallback;
    throw new ApiError(errorId ? `${message}\nError ID: ${errorId}` : message, response.status, data);
  }
  return response.json() as Promise<T>;
}

export const formatNumber = (value: number | string | null | undefined) => new Intl.NumberFormat("en-US").format(Number(value ?? 0));
export const formatIdr = (value: number | string | null | undefined) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value ?? 0));
export const formatMoney = (value: number | string | null | undefined, currency: string | null | undefined) => {
  if (value == null || !currency) return "—";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value)); }
  catch { return `${value} ${currency}`; }
};
