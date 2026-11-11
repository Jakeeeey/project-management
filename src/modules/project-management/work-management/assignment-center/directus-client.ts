import { WorkError } from "./policies";

export type DatabaseRow = Record<string, unknown>;
export interface WorkDatabase {
 read(collection: string, fields: string[], filter: DatabaseRow, limit?: number, page?: number): Promise<DatabaseRow[]>;
 create(collection: string, body: DatabaseRow): Promise<DatabaseRow>;
 createMany(collection: string, bodies: DatabaseRow[], fields?: string[]): Promise<DatabaseRow[]>;
 update(collection: string, id: string, body: DatabaseRow): Promise<void>;
 remove(collection: string, ids: string[]): Promise<void>;
}

/** Server-side Directus transport used by Work Management repositories. */
export class DirectusClient implements WorkDatabase {
 constructor(private base: string, private token: string) { this.base = base.trim().replace(/\/+$/, ""); }
 private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const response = await fetch(`${this.base}${path}`, {
   method, cache: "no-store", headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
   body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
   const error = await response.json().catch(() => ({}));
   const code = error.errors?.[0]?.extensions?.code ?? "DIRECTUS_ERROR";
   // Keep the operation context: Directus errors often otherwise collapse to
   // an unhelpful generic 500 in a multi-step amendment.
   const operation = `${method} ${path.split("?")[0]}`;
   console.error("[work-management] Directus operation failed", { operation, status: response.status, code });
   throw new WorkError(502, code, `Data service request failed during ${operation} (${response.status}, ${code}).`);
  }
  if (response.status === 204) return null;
  const payload = await response.json(); return payload.data;
 }
 async read(collection: string, fields: string[], filter: DatabaseRow, limit = 250, page = 1): Promise<DatabaseRow[]> {
  const sort = collection === "user" ? "user_id" : collection === "department" ? "department_id" : "id";
  const query = new URLSearchParams({ fields: fields.join(","), filter: JSON.stringify(filter), limit: String(limit), page: String(page), sort });
  return await this.request(`/items/${collection}?${query}`) as DatabaseRow[];
 }
 async create(collection: string, body: DatabaseRow): Promise<DatabaseRow> {
  return await this.request(`/items/${collection}`, "POST", body) as DatabaseRow;
 }
 async createMany(collection: string, bodies: DatabaseRow[], fields = ["id"]): Promise<DatabaseRow[]> {
  if (!bodies.length) return [];
  return await this.request(`/items/${collection}?${new URLSearchParams({ fields: fields.join(",") })}`, "POST", bodies) as DatabaseRow[];
 }
 async update(collection: string, id: string, body: DatabaseRow): Promise<void> {
  await this.request(`/items/${collection}/${encodeURIComponent(id)}`, "PATCH", body);
 }
 async remove(collection: string, ids: string[]): Promise<void> {
  if (ids.length) await this.request(`/items/${collection}`, "DELETE", ids);
 }
 async upload(name: string, mime: string, bytes: Uint8Array): Promise<DatabaseRow> {
  const form = new FormData();
  const ownedBuffer = Uint8Array.from(bytes).buffer;
  form.append("file", new Blob([ownedBuffer], { type: mime || "application/octet-stream" }), name);
  const response = await fetch(`${this.base}/files`, { method: "POST", headers: { Authorization: `Bearer ${this.token}` }, body: form, signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
   const payload = await response.json().catch(() => ({}));
   throw new WorkError(502, "UPLOAD_FAILED", `File upload failed (${response.status}, ${payload.errors?.[0]?.extensions?.code ?? "SERVICE_ERROR"}).`);
  }
  return (await response.json()).data;
 }
}
