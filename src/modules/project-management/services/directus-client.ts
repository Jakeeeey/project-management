/**
 * Module-local Directus client for the project-management module.
 *
 * Server-only: the wrapper attaches `DIRECTUS_STATIC_TOKEN`, so importing it from a client
 * component would leak the token into the browser bundle. Every route that uses it declares
 * `runtime = "nodejs"`.
 *
 * Every request funnels through one function, so the invariants the module's scoping depends on
 * live in exactly one place: `cache: "no-store"` (a cached response could serve a stale
 * department scope), an explicit HTTP method, an explicit `Authorization` header, and
 * `encodeURIComponent(JSON.stringify(filter))` for every filter — a Directus filter is a JSON
 * document full of reserved characters and breaks if it is interpolated raw.
 *
 * A non-2xx answer throws `DirectusRequestError` carrying the status and the raw body; routes log
 * that server-side and return the module's own envelope, never Directus's error text.
 */

/** Query options shared by every read. Encoded into the query string by `withQuery`. */
export interface DirectusQuery {
    readonly filter?: Record<string, unknown>;
    readonly fields?: readonly string[];
    readonly sort?: readonly string[];
    /** Directus accepts `-1` for "no limit"; the tasks list relies on that. */
    readonly limit?: number;
    readonly page?: number;
}

/** A non-2xx response from Directus. */
export class DirectusRequestError extends Error {
    readonly status: number;
    readonly collection: string;
    /** The raw response body, kept out of `message` so it is logged, never returned to a client. */
    readonly body: string | null;

    constructor(collection: string, status: number, body: string | null) {
        super(`Directus request for "${collection}" failed with status ${status}`);
        this.name = "DirectusRequestError";
        this.status = status;
        this.collection = collection;
        this.body = body;
    }
}

/** The Directus origin with any trailing slash trimmed, read per call so env edits need no reload. */
export function getDirectusBaseUrl(): string {
    return (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");
}

function collectionUrl(collection: string): string {
    return `${getDirectusBaseUrl()}/items/${encodeURIComponent(collection)}`;
}

function withQuery(url: string, query?: DirectusQuery): string {
    if (query === undefined) return url;

    const params: string[] = [];
    if (query.filter !== undefined) params.push(`filter=${encodeURIComponent(JSON.stringify(query.filter))}`);
    if (query.fields !== undefined) params.push(`fields=${encodeURIComponent(query.fields.join(","))}`);
    if (query.sort !== undefined) params.push(`sort=${encodeURIComponent(query.sort.join(","))}`);
    if (query.limit !== undefined) params.push(`limit=${query.limit}`);
    if (query.page !== undefined) params.push(`page=${query.page}`);

    return params.length === 0 ? url : `${url}?${params.join("&")}`;
}

/**
 * `payload.data || payload || []`, verbatim: Directus wraps a collection in `{ data: [...] }` and a
 * single item in `{ data: {...} }`, some endpoints answer with a bare payload, and a 204 has no
 * body at all.
 */
function unwrapPayload(payload: unknown): unknown {
    if (payload === null || payload === undefined) return [];
    if (typeof payload === "object" && "data" in payload) {
        const data: unknown = payload.data;
        if (data) return data;
    }
    return payload;
}

interface DirectusCall {
    readonly method: "GET" | "POST" | "PATCH";
    readonly url: string;
    readonly body?: unknown;
}

async function request<T>(collection: string, call: DirectusCall): Promise<T> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${process.env.DIRECTUS_STATIC_TOKEN ?? ""}`,
    };
    if (call.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(call.url, {
        method: call.method,
        cache: "no-store",
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });

    if (!response.ok) {
        const errorBody = await response.text().catch((error: unknown) => `Unreadable error body: ${String(error)}`);
        throw new DirectusRequestError(collection, response.status, errorBody);
    }

    const text = await response.text();
    const payload: unknown = text === "" ? null : JSON.parse(text);
    // The one assertion point: JSON has no runtime schema, so each caller names the Directus shape
    // it expects (`ScopedTaskRow`, `ScopedConfigRow`, ...) and owns the field reads that follow.
    return unwrapPayload(payload) as T;
}

/** Reads a collection. A row-shaped answer is reported as an empty list so callers only loop. */
export async function readItems<T>(collection: string, query?: DirectusQuery): Promise<T[]> {
    const rows = await request<unknown>(collection, { method: "GET", url: withQuery(collectionUrl(collection), query) });
    return Array.isArray(rows) ? rows : [];
}

/**
 * Reads one row by primary key. A 404 is "absent", not an error — the caller decides what absence
 * means (the actor resolver treats a missing `user` row as unauthenticated).
 */
export async function readItem<T>(collection: string, id: string | number, query?: DirectusQuery): Promise<T | null> {
    const url = withQuery(`${collectionUrl(collection)}/${encodeURIComponent(String(id))}`, query);
    try {
        const item = await request<T | null>(collection, { method: "GET", url });
        return item ?? null;
    } catch (error) {
        if (error instanceof DirectusRequestError && error.status === 404) return null;
        throw error;
    }
}

/** Creates one row. */
export async function createItem<T>(collection: string, body: unknown): Promise<T> {
    return request<T>(collection, { method: "POST", url: collectionUrl(collection), body });
}

/** Creates many rows in one call (the catalog seed fixture uses this). */
export async function createItems<T>(collection: string, bodies: readonly unknown[]): Promise<T[]> {
    const rows = await request<unknown>(collection, { method: "POST", url: collectionUrl(collection), body: bodies });
    return Array.isArray(rows) ? rows : [];
}

/** Updates one row by primary key. Audit fields are the caller's responsibility. */
export async function updateItem<T>(collection: string, id: string | number, body: unknown): Promise<T> {
    return request<T>(collection, {
        method: "PATCH",
        url: `${collectionUrl(collection)}/${encodeURIComponent(String(id))}`,
        body,
    });
}

/**
 * Updates many rows in one call. Each item must carry its primary key; the reorder and cascade
 * paths use this so a sibling renumbering is a single round-trip.
 */
export async function updateItems<T>(collection: string, items: readonly Record<string, unknown>[]): Promise<T[]> {
    const rows = await request<unknown>(collection, { method: "PATCH", url: collectionUrl(collection), body: items });
    return Array.isArray(rows) ? rows : [];
}
