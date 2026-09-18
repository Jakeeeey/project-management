"use client";

import {
    CalendarDays,
    ChartGantt,
    LayoutDashboard,
    ListTree,
    SquareKanban,
    Users,
    type LucideIcon,
} from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
    TASKS_VIEW_LABELS,
    TASKS_VIEW_ORDER,
    type TasksViewId,
} from "../types/task-view";

/**
 * The tasks page's view switcher.
 *
 * Purely presentational: it renders the tab strip and reports the picked view. The page shell owns the
 * selected view and decides what to mount, so this component never renders a view itself — which is
 * also why it does not use `TabsContent`: the shell must be free to unmount an inactive view (the
 * Gantt and the charts are expensive to keep mounted) without this strip knowing anything about them.
 *
 * Labels are hidden below `sm` and the icon carries the meaning instead, because six labelled tabs do
 * not fit a phone and a horizontally scrolling tab strip hides choices behind a gesture. The
 * accessible name is always the full label, so the control is unambiguous to a screen reader at every
 * width.
 */

/** One icon per view. */
const VIEW_ICONS: Record<TasksViewId, LucideIcon> = {
    list: ListTree,
    board: SquareKanban,
    calendar: CalendarDays,
    team: Users,
    gantt: ChartGantt,
    dashboard: LayoutDashboard,
};

export interface TasksViewTabsProps {
    readonly value: TasksViewId;
    readonly onValueChange: (value: TasksViewId) => void;
}

export function TasksViewTabs({ value, onValueChange }: TasksViewTabsProps) {
    return (
        <Tabs
            value={value}
            onValueChange={(next) => onValueChange(next as TasksViewId)}
            className="w-fit"
        >
            <TabsList aria-label="Task views">
                {TASKS_VIEW_ORDER.map((view) => {
                    const Icon = VIEW_ICONS[view];
                    const label = TASKS_VIEW_LABELS[view];
                    return (
                        <TabsTrigger key={view} value={view} aria-label={label} title={label}>
                            <Icon className="size-4" aria-hidden="true" />
                            <span className="hidden sm:inline">{label}</span>
                        </TabsTrigger>
                    );
                })}
            </TabsList>
        </Tabs>
    );
}