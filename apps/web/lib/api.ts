export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details: Record<string, unknown>) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (typeof init?.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API}${path}`, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.message ?? `Request failed (${response.status})`, response.status, data);
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
