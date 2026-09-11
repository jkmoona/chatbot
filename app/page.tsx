"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";

type Source = {
  id: string;
  score: number;
  filename: string;
  pageNumber: number;
  chunkIndex: number;
  text: string;
};

type Turn = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

const EXAMPLES = [
  "Bu kişinin iş deneyimi nedir?",
  "Which technologies does this person know?",
  "What is the capital of France?",
];

export default function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, streaming]);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (trimmed.length === 0 || streaming) return;

      setError(null);
      setDraft("");
      setStreaming(true);

      const history = [...turns, { role: "user" as const, content: trimmed }];
      setTurns([...history, { role: "assistant", content: "", sources: [] }]);

      const patchAnswer = (patch: (turn: Turn) => Turn) => {
        setTurns((current) => {
          const next = [...current];
          next[next.length - 1] = patch(next[next.length - 1]);
          return next;
        });
      };

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history.map(({ role, content }) => ({ role, content })),
          }),
        });

        if (!response.ok || !response.body) {
          const detail = await response.json().catch(() => ({ error: response.statusText }));
          throw new Error(detail.error ?? "The request failed.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          // The last element is an incomplete line until more bytes arrive.
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.trim().length === 0) continue;
            const event = JSON.parse(line) as
              | { type: "sources"; sources: Source[] }
              | { type: "delta"; text: string }
              | { type: "done" }
              | { type: "error"; error: string };

            if (event.type === "sources") {
              patchAnswer((turn) => ({ ...turn, sources: event.sources }));
            } else if (event.type === "delta") {
              patchAnswer((turn) => ({ ...turn, content: turn.content + event.text }));
            } else if (event.type === "error") {
              setError(event.error);
            }
          }
        }
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setStreaming(false);
      }
    },
    [streaming, turns],
  );

  return (
    <>
      {turns.length === 0 ? (
        <div className="empty">
          <p>Ask about an uploaded document.</p>
          <div className="examples">
            {EXAMPLES.map((example) => (
              <button key={example} onClick={() => void send(example)} disabled={streaming}>
                {example}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="thread">
          {turns.map((turn, index) => {
            const pending =
              index === turns.length - 1 && streaming && turn.role === "assistant";

            return (
              <div className="turn" key={index}>
                <div className={turn.role === "user" ? "question" : "answer"}>
                  {turn.role === "user" ? turn.content : <Markdown>{turn.content}</Markdown>}
                  {pending && turn.content.length === 0 && <span className="dim">searching…</span>}
                  {pending && turn.content.length > 0 && <span className="caret" />}
                </div>
                {turn.sources && turn.sources.length > 0 && (
                  <SourcesDisclosure sources={turn.sources} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
          placeholder="Ask in Turkish or English…"
          rows={1}
          disabled={streaming}
          aria-label="Your question"
        />
        <button type="submit" disabled={streaming || draft.trim().length === 0}>
          {streaming ? "…" : "Ask"}
        </button>
      </form>

      <div ref={bottom} />
    </>
  );
}

/** Scores stay visible so a weak answer can be traced to the chunks behind it. */
function SourcesDisclosure({ sources }: { sources: Source[] }) {
  return (
    <details className="sources">
      <summary>
        <span>
          {sources.length} source{sources.length === 1 ? "" : "s"}
        </span>
        <span className="score">
          {sources.map((source) => source.score.toFixed(3)).join("  ")}
        </span>
      </summary>
      <div className="source-list">
        {sources.map((source) => (
          <div key={source.id}>
            <div className="source-head">
              <span>
                {source.filename} p.{source.pageNumber}
              </span>
              <span className="score">
                {source.score.toFixed(3)} · chunk {source.chunkIndex}
              </span>
            </div>
            <div className="excerpt">{source.text}</div>
          </div>
        ))}
      </div>
    </details>
  );
}
