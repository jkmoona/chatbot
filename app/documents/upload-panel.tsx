"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Result = {
  filename: string;
  pagesRead: number;
  chunksMade: number;
  vectorsStored: number;
};

type Phase = "idle" | "uploading" | "indexing";

export function UploadPanel() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = phase !== "idle";

  // XMLHttpRequest, not fetch: only `upload.onprogress` reports bytes sent.
  const upload = (file: File) => {
    setError(null);
    setResult(null);
    setProgress(0);
    setPhase("uploading");

    const form = new FormData();
    form.append("file", file);

    const request = new XMLHttpRequest();
    request.open("POST", "/api/ingest");

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      setProgress(percent);
      if (percent === 100) setPhase("indexing");
    };

    request.onload = () => {
      setPhase("idle");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(request.responseText) as Record<string, unknown>;
      } catch {
        setError(`Unreadable response (HTTP ${request.status}).`);
        return;
      }

      if (request.status >= 200 && request.status < 300) {
        setResult(body as unknown as Result);
        if (input.current) input.current.value = "";
        router.refresh();
      } else {
        setError(
          typeof body.error === "string" ? body.error : `Upload failed (HTTP ${request.status}).`,
        );
      }
    };

    request.onerror = () => {
      setPhase("idle");
      setError("The upload could not reach the server.");
    };

    request.send(form);
  };

  return (
    <section>
      <h2>Upload</h2>

      <div className="upload-row">
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          aria-label="PDF file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload(file);
          }}
        />
        <button type="button" disabled={busy} onClick={() => input.current?.click()}>
          Choose file
        </button>
      </div>

      {busy && (
        <>
          <div className="bar">
            <span style={{ width: `${phase === "indexing" ? 100 : progress}%` }} />
          </div>
          <p className="dim" style={{ marginTop: "0.6rem" }} aria-live="polite">
            {phase === "uploading" ? `Uploading ${progress}%` : "Extracting and embedding…"}
          </p>
        </>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <p className="result">
          {result.filename} <span className="score">·</span>{" "}
          <span className="score">
            {result.pagesRead} page{result.pagesRead === 1 ? "" : "s"}, {result.chunksMade} chunks,{" "}
            {result.vectorsStored} vectors
          </span>
        </p>
      )}
    </section>
  );
}
