/**
 * Phase-A assertion harness for the services layer's pure cores: the department-scoping invariant
 * (`./department-scope`) and the Permission Matrix (`./permission-matrix`).
 *
 * Run from `project-management/` (Node 24 strips the types natively):
 *   node --experimental-strip-types src/modules/project-management/services/__assert.ts
 * Exit code 0 means every assertion below passed.
 *
 * Both cores import nothing, so this harness proves the scope policy and the whole capability
 * matrix without a database and without the Directus client in the load path. The matrix is asserted
 * for BOTH department policies: `grant` follows the department's `allowAllMembersGrant` setting
 * (head-only when OFF, every member when ON) while `manage-setting` — the toggle itself — stays
 * head-only in both. Why the `.ts` extension and the directive: Node resolves a relative import
 * only when the specifier carries the real file extension, while `tsc` rejects a `.ts` specifier
 * unless `allowImportingTsExtensions` is on — and the project `tsconfig.json` (a protected scaffold
 * file this module may not edit) does not enable it. The directive suppresses only that extension complaint, exactly as
 * `utils/__assert.ts` does; each module is still fully resolved and typed by `tsc`, so
 * `npx tsc --noEmit` stays green alongside this Node run.
 */
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { DepartmentScopeError, assertSameDepartment, isSameDepartment } from "./department-scope.ts";
// @ts-expect-error -- Node requires the ".ts" extension here; tsc forbids it (see the file header).
import { PermissionError, allows, canAssignFrom, canConfigureFrom, canDeleteFrom, canDeleteTaskFrom, canEditFrom, canEditTaskFrom, canGrantFrom, canManageSettingFrom } from "./permission-matrix.ts";

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
    { key: "granted", label: "granted member", isHead: false, hasGrant: true },
    { key: "plain", label: "plain member", isHead: false, hasGrant: false },
] as const;

const MATRIX_POLICIES = [
    { key: "closed", label: "policy OFF", allowAllMembersGrant: false },
    { key: "open", label: "policy ON", allowAllMembersGrant: true },
] as const;

const MATRIX_CAPABILITIES = [
    "view",
    "create",
    "edit",
    "assign",
    "delete",
    "configure",
    "grant",
    "manage-setting",
] as const;

type RoleKey = (typeof MATRIX_ROLES)[number]["key"];
type CapabilityKey = (typeof MATRIX_CAPABILITIES)[number];

const EVERYONE = { head: true, granted: true, plain: true } as const;
const HEAD_OR_GRANTED = { head: true, granted: true, plain: false } as const;
const HEAD_ONLY = { head: true, granted: false, plain: false } as const;

/**
 * The whole matrix, hard-coded per department policy.
 *
 * The "Allow all members Edit access" policy moves SEVEN of the eight capabilities. While it is OFF,
 * edit / assign / delete / configure are head-or-granted and grant is head-only; while it is ON, all
 * five open to every member. `manage-setting` is the sole capability the policy never moves — the
 * toggle stays head-only in both, so the people it empowers can never change it.
 *
 * The per-row creator exception is deliberately absent from this table: it needs the row, so it is
 * asserted separately below.
 */
const EXPECTED_MATRIX: Record<
    (typeof MATRIX_POLICIES)[number]["key"],
    Record<CapabilityKey, Record<RoleKey, boolean>>
> = {
    closed: {
        view: EVERYONE,
        create: EVERYONE,
        edit: HEAD_OR_GRANTED,
        assign: HEAD_OR_GRANTED,
        delete: HEAD_OR_GRANTED,
        configure: HEAD_OR_GRANTED,
        grant: HEAD_ONLY,
        "manage-setting": HEAD_ONLY,
    },
    open: {
        view: EVERYONE,
        create: EVERYONE,
        edit: EVERYONE,
        assign: EVERYONE,
        delete: EVERYONE,
        configure: EVERYONE,
        grant: EVERYONE,
        "manage-setting": HEAD_ONLY,
    },
};

for (const policy of MATRIX_POLICIES) {
    for (const capability of MATRIX_CAPABILITIES) {
        for (const role of MATRIX_ROLES) {
            const actual = allows(capability, {
                isHead: role.isHead,
                hasGrant: role.hasGrant,
                allowAllMembersGrant: policy.allowAllMembersGrant,
            });
            const expected = EXPECTED_MATRIX[policy.key][capability][role.key];
            check(
                `matrix: ${capability} / ${role.label} / ${policy.label}`,
                actual === expected,
                `expected ${expected}`,
            );
        }
    }
}

check(
    "a granted member can never grant while the policy is OFF",
    !canGrantFrom({ isHead: false, hasGrant: true, allowAllMembersGrant: false }),
);
check(
    "a plain member can never grant while the policy is OFF",
    !canGrantFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: false }),
);
check(
    "a plain member may grant while the policy is ON (the new department default)",
    canGrantFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: true }),
);
check(
    "the head may grant in both policies",
    canGrantFrom({ isHead: true, hasGrant: false, allowAllMembersGrant: false })
        && canGrantFrom({ isHead: true, hasGrant: false, allowAllMembersGrant: true }),
);
check(
    "only the head may change the policy, even while the policy is ON",
    canManageSettingFrom({ isHead: true, hasGrant: false, allowAllMembersGrant: true })
        && !canManageSettingFrom({ isHead: false, hasGrant: true, allowAllMembersGrant: true })
        && !canManageSettingFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: true }),
);
check(
    "the head is implicitly assign-capable with no grant row",
    canAssignFrom({ isHead: true, hasGrant: false, allowAllMembersGrant: false }),
);
check(
    "the open policy widens assigning to every member",
    canAssignFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: true })
        && !canAssignFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: false }),
);
check(
    "a granted member may configure (the recorded coupling)",
    canConfigureFrom({ isHead: false, hasGrant: true, allowAllMembersGrant: false }),
);
check(
    "a plain member may configure only while the policy is ON",
    !canConfigureFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: false })
        && canConfigureFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: true }),
);

check(
    "row-aware delete: the task's creator may delete without a grant",
    canDeleteTaskFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: false, isCreator: true }),
);
check(
    "row-aware delete: a plain member who is not the creator may not, while the policy is OFF",
    !canDeleteTaskFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: false, isCreator: false }),
);
check(
    "row-aware delete: the open policy lets any member delete any task",
    canDeleteTaskFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: true, isCreator: false }),
);
check(
    "row-aware delete: a granted member may delete a task they did not create",
    canDeleteTaskFrom({ isHead: false, hasGrant: true, allowAllMembersGrant: false, isCreator: false }),
);
check(
    "row-aware delete: the head may delete a task they did not create",
    canDeleteTaskFrom({ isHead: true, hasGrant: false, allowAllMembersGrant: false, isCreator: false }),
);

check(
    "row-aware edit: the task's creator may edit without a grant",
    canEditTaskFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: false, isCreator: true }),
);
check(
    "row-aware edit: a plain member who is not the creator may not, while the policy is OFF",
    !canEditTaskFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: false, isCreator: false }),
);
check(
    "row-aware edit: a granted member may edit a task they did not create",
    canEditTaskFrom({ isHead: false, hasGrant: true, allowAllMembersGrant: false, isCreator: false }),
);
check(
    "row-aware edit: the head may edit a task they did not create",
    canEditTaskFrom({ isHead: true, hasGrant: false, allowAllMembersGrant: false, isCreator: false }),
);
check(
    "a plain member may edit only while the policy is ON (the access change)",
    !canEditFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: false })
        && canEditFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: true }),
);
check(
    "the policy GRANTS access rather than only the right to grant it",
    canEditFrom({ isHead: false, hasGrant: false, allowAllMembersGrant: true }),
);
check(
    "edit carries the same rule as assign, configure and delete",
    [
        canEditFrom({ isHead: false, hasGrant: true, allowAllMembersGrant: false }),
        canAssignFrom({ isHead: false, hasGrant: true, allowAllMembersGrant: false }),
        canConfigureFrom({ isHead: false, hasGrant: true, allowAllMembersGrant: false }),
        canDeleteFrom({ isHead: false, hasGrant: true, allowAllMembersGrant: false }),
    ].every(Boolean),
);
check(
    "a granted member may edit even while the policy is OFF (the grant is what matters)",
    canEditFrom({ isHead: false, hasGrant: true, allowAllMembersGrant: false }),
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
