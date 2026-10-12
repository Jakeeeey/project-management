import { z } from "zod";

/**
 * Server-side paging for the access roster's `GET` query params.
 *
 * `page` is 1-based; bad or absent values fall back to the defaults rather
 * than failing, and an oversized `pageSize` clamps to the maximum.
 */

/** The first page — also the fallback when `page` is bad or absent. */
export const DEFAULT_ACCESS_PAGE = 1;

/** The fallback when `pageSize` is bad or absent; one of the pager's options. */
export const DEFAULT_ACCESS_PAGE_SIZE = 10;

/** The largest page the route serves; matches the pager's largest option. */
export const MAX_ACCESS_PAGE_SIZE = 50;

/** The longest grant-picker search the route honours; longer input is truncated, never rejected. */
export const MAX_ACCESS_SEARCH_LENGTH = 100;

/** `GET` query params: 1-based `page` plus `pageSize`, each defensive. */
export const AccessListQuerySchema = z.object({
    page: z.coerce.number().int().min(1).catch(DEFAULT_ACCESS_PAGE),
    pageSize: z.coerce.number().int().min(1).catch(DEFAULT_ACCESS_PAGE_SIZE),
    q: z.preprocess(
        (value) => {
            if (typeof value !== "string") return undefined;
            const trimmed = value.trim();
            return trimmed === "" ? undefined : trimmed.slice(0, MAX_ACCESS_SEARCH_LENGTH);
        },
        z.string().trim().max(MAX_ACCESS_SEARCH_LENGTH).optional().catch(undefined),
    ),
});

export type AccessListQuery = z.infer<typeof AccessListQuerySchema>;

/** Applies the size maximum; everything else already resolved in the schema. */
export function clampAccessListQuery(query: AccessListQuery): AccessListQuery {
    const raw = typeof query.q === "string" ? query.q.trim() : "";
    const q = raw === "" ? undefined : raw.slice(0, MAX_ACCESS_SEARCH_LENGTH);
    return { page: query.page, pageSize: Math.min(query.pageSize, MAX_ACCESS_PAGE_SIZE), q };
}
