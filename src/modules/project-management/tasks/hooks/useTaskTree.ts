"use client";

import { useCallback, useMemo, useState } from "react";

import { buildTree, flattenVisible, type TreeNode } from "@/modules/project-management/utils/tree";

import type { TaskListItem } from "./useTasks";

/**
 * The task tree hook — pure assembly over the flat rows plus the expand/collapse state.
 *
 * The server returns the department's rows **flat** and sorted globally by `(sort_order, id)`, so a
 * child can precede its parent in `data`. The hierarchy lives entirely in `parent_id`, which is why
 * this hook always assembles through `buildTree` — the tree helpers are orphan- and cycle-tolerant,
 * so a malformed row renders as a root instead of vanishing.
 *
 * Expand/collapse state is owned here (not by the page) so it survives every refetch: `refresh`
 * replaces the rows, and the ids that still exist keep their expansion. Ids whose rows are gone are
 * pruned from the projection, so a removed branch cannot leave stale state behind.
 *
 * Assignee names come from the caller's member directory (the directory-aware `useAssignees`), keyed
 * by user id; an id the directory does not know renders as `User #<id>` rather than a blank label.
 * Passing no map is valid — the tree still renders, just with fallback names.
 */

/** An assignee as the tree renders it: the id plus the directory's display name. */
export interface TaskTreeAssignee {
    readonly user_id: number;
    readonly full_name: string;
}

/**
 * A task row as the tree renders it. Structurally satisfies `TaskRowView`, so `TaskTree` and the
 * drag-and-drop engine accept these nodes without a second mapping step.
 */
export interface TaskTreeRow extends Omit<TaskListItem, "assignees"> {
    readonly assignees: readonly TaskTreeAssignee[];
}

/** The canonical return of the tree hook. */
export interface UseTaskTreeResult {
    /** The assembled forest — what `TaskTree` and `TreeDndProvider` take as `roots`. */
    readonly roots: TreeNode<TaskTreeRow>[];
    /** The pre-order projection of the expanded subtrees, in render order. */
    readonly visible: TreeNode<TaskTreeRow>[];
    /** The ids whose children are currently shown, pruned to rows that still exist. */
    readonly expandedIds: ReadonlySet<number>;
    readonly toggleExpand: (id: number) => void;
    readonly setExpanded: (id: number, expanded: boolean) => void;
    /** Expands every node that owns children (a leaf has no meaningful expanded state). */
    readonly expandAll: () => void;
    readonly collapseAll: () => void;
}

/** Stable identity for the no-directory case, so the row projection is not rebuilt every render. */
const NO_NAMES: ReadonlyMap<number, string> = new Map<number, string>();

/** The directory's name for a user id, or a stable fallback — never a blank label. */
function displayName(userId: number, memberNameById: ReadonlyMap<number, string>): string {
    return memberNameById.get(userId) ?? `User #${userId}`;
}

/**
 * Assembles the department's flat rows into the forest the tree renders, resolving assignee names
 * from the member directory.
 *
 * @param rows           The flat rows from `useTasks` — in the server's order; `buildTree` re-sorts
 *                       every level by `(sort_order, id)`.
 * @param memberNameById Display names keyed by user id (from `useAssignees`); optional, and a miss
 *                       falls back to `User #<id>`.
 * @returns the canonical `{ roots, visible, expandedIds, toggleExpand, setExpanded, expandAll,
 *          collapseAll }` surface.
 */
export function useTaskTree(
    rows: readonly TaskListItem[],
    memberNameById: ReadonlyMap<number, string> = NO_NAMES,
): UseTaskTreeResult {
    const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(() => new Set<number>());

    const viewRows = useMemo<TaskTreeRow[]>(
        () =>
            rows.map((row) => ({
                ...row,
                assignees: row.assignees.map((assignee) => ({
                    user_id: assignee.user_id,
                    full_name: displayName(assignee.user_id, memberNameById),
                })),
            })),
        [rows, memberNameById],
    );

    const roots = useMemo(() => buildTree(viewRows), [viewRows]);

    // Ids are pruned against the current rows so a deleted branch cannot keep stale expansion.
    const presentIds = useMemo(() => new Set(viewRows.map((row) => row.id)), [viewRows]);
    const activeExpandedIds = useMemo<ReadonlySet<number>>(() => {
        const pruned = new Set<number>();
        for (const id of expandedIds) {
            if (presentIds.has(id)) pruned.add(id);
        }
        return pruned;
    }, [expandedIds, presentIds]);

    const visible = useMemo(() => flattenVisible(roots, activeExpandedIds), [roots, activeExpandedIds]);

    const toggleExpand = useCallback((id: number): void => {
        setExpandedIds((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const setExpanded = useCallback((id: number, expanded: boolean): void => {
        setExpandedIds((previous) => {
            if (previous.has(id) === expanded) return previous;
            const next = new Set(previous);
            if (expanded) next.add(id);
            else next.delete(id);
            return next;
        });
    }, []);

    const expandAll = useCallback((): void => {
        const parents = new Set<number>();
        const stack: TreeNode<TaskTreeRow>[] = [...roots];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node === undefined) continue;
            if (node.children.length > 0) parents.add(node.id);
            for (const child of node.children) stack.push(child);
        }
        setExpandedIds(parents);
    }, [roots]);

    const collapseAll = useCallback((): void => {
        setExpandedIds(new Set<number>());
    }, []);

    return {
        roots,
        visible,
        expandedIds: activeExpandedIds,
        toggleExpand,
        setExpanded,
        expandAll,
        collapseAll,
    };
}
