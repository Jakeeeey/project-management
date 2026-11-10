"use client";

import { useRef, useState } from "react";
import type { Detail, WorkFile } from "../types";
import type { WorkApi } from "../shared/workspace-types";

interface Options {
 detail: Detail | null;
 api: WorkApi;
 onBusyChange: (busy: boolean) => void;
 onError: (message: string) => void;
 onSubmitted: () => Promise<void>;
}

/** Kept in the detail host so drafts survive switching between detail tabs. */
export function useSubmission({ detail, api, onBusyChange, onError, onSubmitted }: Options) {
  const pending = useRef<{ signature: string; key: string; ids: string[] } | null>(null);
 const [files, setFiles] = useState<File[]>([]);
 const [remark, setRemark] = useState("");
  const submit = async () => {
   if (!detail) return;
   if (!files.length) { onError("Attach at least one deliverable file."); return; }
   if (files.length > 10 || files.some(file => file.size <= 0 || file.size > 5 * 1024 * 1024)) { onError("Choose up to 10 nonempty files, each no larger than 5 MB."); return; }
   onBusyChange(true); onError("");
   try {
    const signature = JSON.stringify([detail.id, detail.row_version, remark, files.map(file => [file.name, file.size, file.lastModified])]);
    if (!pending.current || pending.current.signature !== signature) pending.current = { signature, key: crypto.randomUUID(), ids: [] };
    const ids = pending.current.ids;
    while (ids.length < files.length) {
     const file = files[ids.length]; const data = new FormData(); data.append("file", file);
     const upload = await api<WorkFile>("uploads/stage", { method: "POST", body: data }); ids.push(upload.id);
    }
    await api(`occurrences/${detail.id}/submissions`, {
     method: "POST",
     headers: { "Idempotency-Key": pending.current.key },
     body: JSON.stringify({ file_upload_ids: ids, remark, revision_reason: "", expected_revision: detail.row_version }),
   });
    pending.current = null; setFiles([]); setRemark("");
   await onSubmitted();
  } catch (error) { onError(error instanceof Error ? error.message : "Submission failed."); }
  finally { onBusyChange(false); }
 };
  return { files, setFiles, remark, setRemark, submit };
}

export type SubmissionController = ReturnType<typeof useSubmission>;
