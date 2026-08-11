export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message ?? `Request failed (${response.status})`);
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
