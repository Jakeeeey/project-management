"use client";

import type { ReactNode } from "react";
import { ListChecks, SlidersHorizontal, type LucideIcon } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { TaskFieldsSection } from "@/modules/project-management/task-management/tasks/components/TaskFieldsSection";

import { TaskConfigurationSection } from "./TaskConfigurationSection";

/**
 * The section registry — the single edit point for the Configure page.
 *
 * Adding a future configure section is one entry here: the tab strip and the panels are both mapped
 * from this array, so nothing else in the page has to change. `render` returns the section element
 * rather than a component reference so a section's own call site (and any key it needs) stays local.
 */
interface ConfigureSection {
    readonly id: string;
    readonly label: string;
    readonly icon: LucideIcon;
    readonly render: () => ReactNode;
}

const CONFIGURE_SECTIONS: readonly ConfigureSection[] = [
    {
        id: "catalogs",
        label: "Status & priority",
        icon: ListChecks,
        render: () => <TaskConfigurationSection />,
    },
    {
        id: "custom-fields",
        label: "Custom fields",
        icon: SlidersHorizontal,
        render: () => <TaskFieldsSection />,
    },
];

/**
 * The Configure page's section switcher.
 *
 * One long scroll became tabs so the page keeps scaling as sections are added. Each section renders
 * itself and owns its own capabilities read, so a section whose server answer is "not configurable"
 * still renders nothing — this shell never inspects capabilities.
 *
 * Labels are hidden below `sm` with the accessible name kept on the trigger, because labelled tabs
 * stop fitting a phone at two and a scrolling strip would hide choices behind a gesture.
 *
 * `whitespace-nowrap` is load-bearing, not cosmetic, and it belongs on the LABEL SPAN rather than the
 * trigger: a trigger is `flex-1`, so a multi-word label's min-content width is one word per line and
 * it wraps — which is why "Statuses & priorities" rendered on two rows beside the single-word "Custom
 * fields". Putting nowrap on the span is what makes its min-content the whole label, so the strip
 * widens instead of breaking the text; the same class on the trigger alone does not reach the span.
 */
export function ConfigureSections() {
    return (
        <Tabs defaultValue={CONFIGURE_SECTIONS[0].id} className="w-full">
            <div className="mx-auto w-full max-w-3xl px-4 pt-2">
                <TabsList aria-label="Configure sections" className="w-full sm:w-auto">
                    {CONFIGURE_SECTIONS.map((section) => {
                        const Icon = section.icon;
                        return (
                            <TabsTrigger
                                key={section.id}
                                value={section.id}
                                aria-label={section.label}
                                title={section.label}
                                className="whitespace-nowrap"
                            >
                                <Icon className="size-4" aria-hidden="true" />
                                <span className="hidden whitespace-nowrap sm:inline">{section.label}</span>
                            </TabsTrigger>
                        );
                    })}
                </TabsList>
            </div>

            {CONFIGURE_SECTIONS.map((section) => (
                <TabsContent key={section.id} value={section.id}>
                    {section.render()}
                </TabsContent>
            ))}
        </Tabs>
    );
}
