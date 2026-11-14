export const HARNESS_URL = (import.meta.env.VITE_HARNESS_URL || "http://localhost:3010").replace(/\/+$/, "");
export const HARNESS_TOKEN: string = import.meta.env.VITE_HARNESS_TOKEN || "";

export function authHeaders(): Record<string, string> {
  return HARNESS_TOKEN ? { Authorization: `Bearer ${HARNESS_TOKEN}` } : {};
}
