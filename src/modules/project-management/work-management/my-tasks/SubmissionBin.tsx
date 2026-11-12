"use client";

import { CheckCircle2, FileUp, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Detail } from "./types";
import type { SubmissionController } from "./useSubmission";

export function SubmissionBin({ detail, controller, busy, changed }: {
 detail: Detail;
 controller: SubmissionController;
 busy: boolean;
 changed: boolean;
}) {
  const { files, setFiles, remark, setRemark, submit } = controller;
  const [selectionMessage, setSelectionMessage] = useState("");
  const addFiles = (selected: File[]) => {
   const oversized = selected.filter(file => file.size > 5 * 1024 * 1024).length;
   const acceptable = selected.filter(file => file.size > 0 && file.size <= 5 * 1024 * 1024);
   const remaining = Math.max(0, 10 - files.length);
   const skippedByLimit = Math.max(0, acceptable.length - remaining);
   setFiles(current => [...current, ...acceptable.slice(0, Math.max(0, 10 - current.length))]);
   setSelectionMessage([oversized && `${oversized} file(s) skipped: each file must be 5 MB or smaller.`, skippedByLimit && `${skippedByLimit} file(s) skipped: the limit is 10 files per submission.`].filter(Boolean).join(" "));
  };
 return <section className="space-y-3 rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 p-4">
  <div className="flex items-center gap-2"><FileUp className="size-5 text-primary" /><h3 className="font-semibold">Submission Bin</h3></div>
   <p className="text-xs text-muted-foreground">At least one attachment · any file type · max 5 MB each · up to 10 files. Submitting completes only your obligation.</p>
   <label className="block cursor-pointer rounded-lg border bg-background p-4 text-center text-sm">Select files; you can add more in another selection<input aria-label="Deliverable attachments" type="file" multiple disabled={busy || files.length >= 10} className="sr-only" onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} /></label>
   {selectionMessage && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">{selectionMessage}</p>}
  {files.map((file, index) => <div key={`${file.name}-${index}`} className="flex items-center justify-between text-xs"><span>{file.name} ({Math.round(file.size / 1024)} KiB)</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => setFiles(current => current.filter((_, position) => position !== index))}>Remove</Button></div>)}
  <label className="block text-sm">Remark (optional)<Textarea value={remark} onChange={event => setRemark(event.target.value)} /></label>
   <Button disabled={busy || changed || !files.length || files.length > 10 || files.some(file => file.size <= 0 || file.size > 5 * 1024 * 1024)} onClick={submit}>{busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}{detail.first_submission_id ? "Submit New Version" : "Submit Deliverable"}</Button>
  <p className="text-xs text-muted-foreground">No approval gate. Late submissions remain accepted. Reviewer comments never reverse completion.</p>
 </section>;
}
