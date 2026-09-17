/**
 * Phase-A assertion harness for the services layer's pure cores: the department-scoping invariant
 * (`./department-scope`) and the Permission Matrix (`./permission-matrix`).
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/services/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * Both cores import nothing, so this harness proves the scope policy and the whole capability
 * matrix without a database and without the Directus client in the load path. Why the `.ts`
 * extension and the directive: Node resolves a relative import only when the specifier carries the
 * real file extension, while `tsc` rejects a `.ts` specifier unless `allowImportingTsExtensions` is
 * on — and the project `tsconfig.json` (a protected scaffold file this module may not edit) does
 * not enable it. The directive suppresses only that extension complaint, exactly as
 * `utils/__assert.ts` does; each module is still fully resolved and typed by `tsc`, so
 * `npx tsc --noEmit` stays green alongside this Node run.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { DepartmentScopeError, assertSameDepartment, isSameDepartment } from "./department-scope.ts";
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { PermissionError, allows, canAssignFrom, canConfigureFrom, canDeleteTaskFrom, canGrantFrom } from "./permission-matrix.ts";

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

function passes(run: () => void): boolean {
    try {
        run();
        return true;
    } catch {
        return false;
    }
}

function throwsScopeError(run: () => void): boolean {
    try {
        run();
        return false;
    } catch (error) {
        return error instanceof DepartmentScopeError;
    }
}

const OWN_ROW = { department_id: 7 };
const FOREIGN_ROW = { department_id: 8 };

check("isSameDepartment: a matching department is true", isSameDepartment(OWN_ROW, 7));
check("isSameDepartment: a mismatched department is false", !isSameDepartment(FOREIGN_ROW, 7));
check("isSameDepartment: a null row department is false", !isSameDepartment({ department_id: null }, 7));
check("isSameDepartment: an absent row department is false", !isSameDepartment({}, 7));
check("isSameDepartment: a null actor department never matches", !isSameDepartment(OWN_ROW, null));
check("isSameDepartment: a null row is false", !isSameDepartment(null, 7));
check("isSameDepartment: a string-shaped Directus int still matches", isSameDepartment({ department_id: "7" }, 7));

check(
    "assertSameDepartment: passes for the actor's own department",
    passes(() => assertSameDepartment({ departmentId: 7 }, OWN_ROW)),
);
check(
    "assertSameDepartment: throws DepartmentScopeError for another department's row",
    throwsScopeError(() => assertSameDepartment({ departmentId: 7 }, FOREIGN_ROW)),
);
check(
    "assertSameDepartment: a null actor department can never match a row",
    throwsScopeError(() => assertSameDepartment({ departmentId: null }, OWN_ROW)),
);

const MATRIX_ROLES = [
    { key: "head", label: "department head", isHead: true, hasGrant: false },
    { key: "granted", label: "granted assigner", isHead: false, hasGrant: true },
    { key: "plain", label: "plain member", isHead: false, hasGrant: false },
] as const;

const MATRIX_CAPABILITIES = ["view", "create", "edit", "assign", "delete", "configure", "grant"] as const;

const EXPECTED_MATRIX: Record<
    (typeof MATRIX_ROLES)[number]["key"],
    Record<(typeof MATRIX_CAPABILITIES)[number], boolean>
> = {
    head: { view: true, create: true, edit: true, assign: true, delete: true, configure: true, grant: true },
    granted: { view: true, create: true, edit: true, assign: true, delete: true, configure: true, grant: false },
    plain: { view: true, create: true, edit: true, assign: false, delete: false, configure: false, grant: false },
};

for (const capability of MATRIX_CAPABILITIES) {
    for (const role of MATRIX_ROLES) {
        const actual = allows(capability, { isHead: role.isHead, hasGrant: role.hasGrant });
        const expected = EXPECTED_MATRIX[role.key][capability];
        check(`matrix: ${capability} / ${role.label}`, actual === expected, `expected ${expected}`);
    }
}

check("a granted assigner can never grant", !canGrantFrom({ isHead: false, hasGrant: true }));
check("a plain member can never grant", !canGrantFrom({ isHead: false, hasGrant: false }));
check("the head is implicitly assign-capable with no grant row", canAssignFrom({ isHead: true, hasGrant: false }));
check(
    "a granted assigner may configure (the recorded coupling)",
    canConfigureFrom({ isHead: false, hasGrant: true }),
);
check("a plain member may not configure", !canConfigureFrom({ isHead: false, hasGrant: false }));

check(
    "row-aware delete: the task's creator may delete without a grant",
    canDeleteTaskFrom({ isHead: false, hasGrant: false, isCreator: true }),
);
check(
    "row-aware delete: a plain member who is not the creator may not",
    !canDeleteTaskFrom({ isHead: false, hasGrant: false, isCreator: false }),
);
check(
    "row-aware delete: a granted assigner may delete a task they did not create",
    canDeleteTaskFrom({ isHead: false, hasGrant: true, isCreator: false }),
);
check(
    "row-aware delete: the head may delete a task they did not create",
    canDeleteTaskFrom({ isHead: true, hasGrant: false, isCreator: false }),
);

const forbidden = new PermissionError();
check(
    "PermissionError carries the FORBIDDEN code and a FORBIDDEN-prefixed message",
    forbidden instanceof Error && forbidden.code === "FORBIDDEN" && forbidden.message.startsWith("FORBIDDEN:"),
    forbidden.message,
);

if (failures > 0) {
    throw new Error(`${failures} of ${checks} assertions failed`);
}
console.log(`\n${checks} assertions passed`);
