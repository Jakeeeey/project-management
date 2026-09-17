/**
 * Pure-logic assertion harness for the project-management module's shared spine.
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/utils/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * Why the `.ts` extensions and the directives on the imports: Node's loader resolves a relative
 * import only when the specifier carries the real file extension, while `tsc` rejects a `.ts`
 * specifier unless `allowImportingTsExtensions` is on — and the project `tsconfig.json` (a
 * protected scaffold file this module may not edit) does not enable it. The directives suppress
 * only that extension complaint; each module is still fully resolved and typed by `tsc`, so
 * `npx tsc --noEmit` stays green alongside this Node run.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { phNow } from "./ph-time.ts";
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { buildTree, collectDescendantIds, computeDepth, flattenVisible, isDescendant } from "./tree.ts";
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { CreateTaskSchema, MoveTaskSchema, UpdateTaskSchema } from "../tasks/types/pm-task.schema.ts";

interface ChainRow {
    id: number;
    parent_id: number | null;
    sort_order: number;
}

let checks = 0;
let failures = 0;

function check(label: string, passed: boolean, detail: string = ""): void {
    checks += 1;
    const suffix = detail === "" ? "" : ` (${detail})`;
    if (passed) {
        console.log(`ok   - ${label}${suffix}`);
        return;
    }
    failures += 1;
    console.error(`FAIL - ${label}${suffix}`);
}

function mustFind<T extends { id: number; children: T[] }>(nodes: readonly T[], id: number): T {
    const stack: T[] = [...nodes];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined) continue;
        if (node.id === id) return node;
        for (const child of node.children) stack.push(child);
    }
    throw new Error(`fixture row ${id} is missing from the built tree`);
}

/** 1 -> 2 -> 3 -> 4 -> 5 -> 6: six levels, so the deepest row must report depth 5. */
const chain: ChainRow[] = [
    { id: 1, parent_id: null, sort_order: 0 },
    { id: 2, parent_id: 1, sort_order: 0 },
    { id: 3, parent_id: 2, sort_order: 0 },
    { id: 4, parent_id: 3, sort_order: 0 },
    { id: 5, parent_id: 4, sort_order: 0 },
    { id: 6, parent_id: 5, sort_order: 0 },
];
const chainIds = new Set(chain.map((row) => row.id));
const forest = buildTree(chain);
const root = mustFind(forest, 1);
const child = mustFind(forest, 2);
const greatGrandchild = mustFind(forest, 4);

const depths = flattenVisible(forest, chainIds).map((node) => node.depth);
check(
    "a 6-level chain reports depths 0..5",
    JSON.stringify(depths) === JSON.stringify([0, 1, 2, 3, 4, 5]),
    `saw ${depths.join(",")}`,
);
check("computeDepth walks the chain to 5", computeDepth(chain, 6) === 5, `saw ${computeDepth(chain, 6)}`);
check("isDescendant(root, greatGrandchild) is true", isDescendant(chain, root.id, greatGrandchild.id));
check("isDescendant(child, root) is false", !isDescendant(chain, child.id, root.id));
check("isDescendant(greatGrandchild, root) is false", !isDescendant(chain, greatGrandchild.id, root.id));
check("a node is not its own descendant", !isDescendant(chain, root.id, root.id));

const descendantIds = collectDescendantIds(chain, root.id);
check(
    "collectDescendantIds returns descendants deepest-first",
    JSON.stringify(descendantIds) === JSON.stringify([6, 5, 4, 3, 2]),
    `saw ${descendantIds.join(",")}`,
);
check(
    "collectDescendantIds excludes the node itself",
    !collectDescendantIds(chain, child.id).includes(child.id),
);

const orphan: ChainRow = { id: 99, parent_id: 4242, sort_order: 0 };
const withOrphan = buildTree([...chain, orphan]);
check(
    "an orphan whose parent id is missing is returned as a root",
    withOrphan.some((node) => node.id === orphan.id),
);
check("the orphan's depth is 0", mustFind(withOrphan, orphan.id).depth === 0);
const allIds = new Set([...chainIds, orphan.id]);
const visibleWithOrphan = flattenVisible(withOrphan, allIds);
check("no row is dropped when an orphan is present", visibleWithOrphan.length === 7, `saw ${visibleWithOrphan.length}`);

const collapsed = flattenVisible(forest, new Set<number>());
check("a collapsed forest renders roots only", collapsed.length === 1 && collapsed[0].id === root.id);

check(
    "MoveTaskSchema accepts an ordered sibling list",
    MoveTaskSchema.safeParse({ parent_id: 1, sibling_ids: [3, 2, 4] }).success,
);
check(
    "MoveTaskSchema accepts a move to root (parent_id: null)",
    MoveTaskSchema.safeParse({ parent_id: null, sibling_ids: [9] }).success,
);
check(
    "MoveTaskSchema rejects a sibling_ids list containing a duplicate",
    !MoveTaskSchema.safeParse({ parent_id: 1, sibling_ids: [2, 3, 2] }).success,
);
check(
    "MoveTaskSchema rejects an empty sibling_ids list",
    !MoveTaskSchema.safeParse({ parent_id: 1, sibling_ids: [] }).success,
);

check("CreateTaskSchema requires a non-blank title", !CreateTaskSchema.safeParse({ title: "   " }).success);
const patched = UpdateTaskSchema.safeParse({ title: "renamed", parent_id: 7 });
check(
    "UpdateTaskSchema strips parent_id (re-parenting belongs to the move route)",
    patched.success && !("parent_id" in patched.data),
);
check("UpdateTaskSchema accepts a partial body", UpdateTaskSchema.safeParse({ priority_id: null }).success);

const stamp = phNow();
check(
    "phNow() emits the PH-time 'YYYY-MM-DD HH:mm:ss' shape",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp),
    stamp,
);
check("phNow() never emits the UTC ISO wrapper", !stamp.includes("T") && !stamp.endsWith("Z"));

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);
