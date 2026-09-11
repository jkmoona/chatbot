import { NextResponse } from "next/server";

import { assertConfig } from "@/lib/config";
import { EmbeddingRateLimitError } from "@/lib/embed";
import {
  type ChatMessage,
  NO_ANSWER,
  type Retrieval,
  answerStream,
  buildMessages,
  retrieve,
} from "@/lib/rag";

export const runtime = "nodejs";
export const maxDuration = 120;

type Body = {
  messages?: { role?: string; content?: string }[];
};

/**
 * Newline-delimited JSON, one event per line:
 *
 *   {"type":"sources","sources":[...]}   once, first
 *   {"type":"delta","text":"..."}        many
 *   {"type":"done"}                      once, last
 *   {"type":"error","error":"..."}        instead of done, on failure
 *
 * Sources go first so the UI can show them before the first token arrives.
 */
function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

export async function POST(request: Request) {
  try {
    assertConfig();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const messages: ChatMessage[] = (body.messages ?? [])
    .filter(
      (message): message is ChatMessage =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    )
    .map((message) => ({ role: message.role, content: message.content.trim() }));

  const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
  if (lastUserIndex === -1) {
    return NextResponse.json(
      { error: "No user message found in the messages array." },
      { status: 400 },
    );
  }

  const question = messages[lastUserIndex].content;
  const history = messages.slice(0, lastUserIndex);

  let retrieved: Retrieval;
  try {
    // History is passed so a follow-up can be rewritten into something
    // searchable before it is embedded.
    retrieved = await retrieve(question, history);
  } catch (error) {
    console.error("retrieval failed", error);
    if (error instanceof EmbeddingRateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    return NextResponse.json(
      { error: `Retrieval failed: ${(error as Error).message}` },
      { status: 500 },
    );
  }

  const { chunks, searchQuery } = retrieved;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(line(event)));

      send({
        type: "sources",
        sources: chunks.map((chunk) => ({
          id: chunk.id,
          score: chunk.score,
          filename: chunk.filename,
          pageNumber: chunk.pageNumber,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
        })),
      });

      // The model is never called, which is what stops it answering from its
      // own knowledge.
      if (chunks.length === 0) {
        console.log(
          JSON.stringify({ event: "refusal", question, reason: "no_chunks_above_threshold" }),
        );
        send({ type: "delta", text: NO_ANSWER });
        send({ type: "done" });
        controller.close();
        return;
      }

      try {
        for await (const text of answerStream(buildMessages(question, chunks, history, searchQuery))) {
          send({ type: "delta", text });
        }
        send({ type: "done" });
      } catch (error) {
        console.error("answer stream failed", error);
        send({ type: "error", error: (error as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
