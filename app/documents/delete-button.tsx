"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DeleteButton({ docId, filename }: { docId: string; filename: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!window.confirm(`Remove "${filename}" and all of its chunks from the index?`)) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(docId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(detail.error ?? "Delete failed.");
      }
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="link-danger" type="button" onClick={remove} disabled={busy}>
        {busy ? "Removing…" : "Remove"}
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
