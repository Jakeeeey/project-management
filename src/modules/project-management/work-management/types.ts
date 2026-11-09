export type Workspace = "assignor" | "my-tasks" | "executive";
export type Role = "DEPARTMENT_ASSIGNOR" | "GLOBAL_ASSIGNOR" | "ASSIGNEE" | "EXECUTIVE_VIEWER";
export type Frequency = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY" | "CUSTOM";
export interface Employee {
 id: string; name: string; department_id: string; department: string; roles: Role[];
 /** Trusted server-derived view access; never a business write role. */
 read_workspaces?: Workspace[];
 read_all_departments?: boolean;
}
export interface Schedule {
 frequency: Frequency; interval_value: number; interval_unit?: "DAY" | "WEEK" | "MONTH";
 days_of_week: number[]; day_of_month?: number; month_end_policy: "CLAMP_TO_LAST_DAY" | "SKIP";
 due_local_time: string; timezone: string; start_date: string; end_date?: string; until_count?: number;
}
export interface Task {
 id: string; title: string; description: string; scope_type: "DEPARTMENT" | "GLOBAL";
 department_id: string | null; created_by: string; report_to_user_id: string;
 priority: "LOW" | "NORMAL" | "HIGH" | "CRITICAL"; availability_start_at: string;
 schedule: Schedule; schedule_version: number; schedule_effective_at: string; revision_number: number;
 lifecycle_status: "ACTIVE" | "PAUSED" | "CANCELLED"; created_at: string;
 reference_file_ids: string[];
}
export interface Assignment { id: string; task_id: string; assignee_user_id: string; department_id_at_assignment: string; status: "ACTIVE" | "ENDED" }
export interface Occurrence {
 id: string; task_id: string; assignment_id: string; occurrence_key: string;
 scheduled_local_date: string; available_at: string; original_due_at: string; due_at: string;
 row_version: number; task_revision: Task; status: "SCHEDULED" | "OPEN" | "COMPLETED" | "CANCELLED";
 completed_at: string | null; first_submission_id: string | null; latest_submission_id: string | null;
}
export interface Submission { id: string; occurrence_id: string; version_number: number; submitted_by: string; submitted_at: string; evaluated_due_at: string; is_late: boolean; remark: string; revision_reason: string; file_ids: string[] }
export interface WorkFile { id: string; owner_id: string; name: string; mime: string; size: number; sha256: string; expires_at: string; state: "VERIFIED" | "CLAIMED"; bytes: string }
export interface AuditEvent { id: string; event_type: string; task_id: string; occurrence_id: string | null; actor_id: string; reason: string; old_values: unknown; new_values: unknown; created_at: string; request_id: string; material: boolean }
export interface Comment { id: string; occurrence_id: string; submission_id: string | null; author_id: string; text: string; created_at: string }
export interface Notification { id: string; recipient_id: string; event_id: string; type: string; read_at: string | null; created_at: string }
export interface State {
 employees: Employee[]; tasks: Task[]; assignments: Assignment[]; occurrences: Occurrence[];
 submissions: Submission[]; files: WorkFile[]; events: AuditEvent[]; comments: Comment[];
 acknowledgments: { occurrence_id: string; event_id: string; user_id: string }[];
 notifications: Notification[];
 outbox: { id: string; event_id: string; recipients: string[]; delivered_at: string | null; attempts: number }[];
 idempotency: Record<string, { hash: string; response: unknown }>;
}
export interface Summary { due: number; submitted: number; on_time: number; overdue: number; backlog: number }
export interface Bootstrap {
 mode: "LIVE"; actor: Employee; identities: Employee[]; employees: Employee[];
 writes_enabled?: boolean;
 uploads_enabled?: boolean;
 workspace_access?: Workspace[];
 capabilities: { assign: boolean; executive: boolean; global: boolean }; blockers: string[];
}
export interface OccurrenceView extends Occurrence { task: Task; assignee: Employee; submissions: Submission[] }
export interface Detail extends OccurrenceView {
 events: AuditEvent[]; comments: Comment[]; files: Omit<WorkFile, "bytes">[];
 unacknowledged: AuditEvent[]; can_edit: boolean; can_submit: boolean; can_comment: boolean;
}
