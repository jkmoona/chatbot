import { VoyageAIClient } from "voyageai";

import { embedding } from "./config";

let client: VoyageAIClient | undefined;

function getClient(): VoyageAIClient {
  if (!client) {
    client = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY ?? "" });
  }
  return client;
}

/** Divides by 3, not 4: Turkish packs fewer characters per token than English. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Groups texts under both Voyage ceilings; count alone would breach the token cap. */
function batch(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const text of texts) {
    const tokens = estimateTokens(text);
    const full = current.length >= embedding.batchSize;
    const overflows = current.length > 0 && currentTokens + tokens > embedding.maxBatchTokens;

    if (full || overflows) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(text);
    currentTokens += tokens;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export type EmbedStats = {
  requests: number;
  /** As reported by Voyage, so this is the billable figure. */
  totalTokens: number;
};

export class EmbeddingRateLimitError extends Error {
  constructor() {
    super(
      "The embedding service is rate limiting this key. Voyage's free tier allows " +
        "3 requests per minute; adding a payment method raises it to 2000 while still " +
        "spending the free token grant. Wait a moment and ask again.",
    );
    this.name = "EmbeddingRateLimitError";
  }
}

const MAX_ATTEMPTS = 4;

function statusOf(error: unknown): number | undefined {
  const { statusCode, status } = error as { statusCode?: number; status?: number };
  return statusCode ?? status;
}

function delayFor(error: unknown, attempt: number): number {
  const { rawResponse } = error as { rawResponse?: Response };
  const retryAfter = Number(rawResponse?.headers?.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);

  return Math.min(2_000 * 2 ** attempt, 24_000) + Math.random() * 500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries on 429 and 5xx. Rate limits are routine on the free tier. */
async function withRetry<T>(request: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const status = statusOf(error);
      if (status !== 429 && !(status && status >= 500)) throw error;

      lastError = error;
      if (attempt < MAX_ATTEMPTS - 1) {
        const wait = delayFor(error, attempt);
        console.warn(
          JSON.stringify({ event: "embed_retry", status, attempt: attempt + 1, waitMs: Math.round(wait) }),
        );
        await sleep(wait);
      }
    }
  }

  if (statusOf(lastError) === 429) throw new EmbeddingRateLimitError();
  throw lastError;
}

/**
 * Private so `inputType` cannot be mixed up: Voyage prepends a different
 * instruction for documents and queries, and the wrong one degrades retrieval.
 */
async function embedAll(
  texts: string[],
  inputType: "document" | "query",
): Promise<{ vectors: number[][]; stats: EmbedStats }> {
  const vectors: number[][] = [];
  const stats: EmbedStats = { requests: 0, totalTokens: 0 };

  for (const group of batch(texts)) {
    const response = await withRetry(() =>
      getClient().embed({
        input: group,
        model: embedding.model,
        inputType,
        outputDimension: embedding.dimensions,
        truncation: true,
      }),
    );

    const data = response.data ?? [];
    if (data.length !== group.length) {
      throw new Error(
        `Voyage returned ${data.length} embeddings for ${group.length} inputs (model ${embedding.model}).`,
      );
    }

    // Sort by the reported index rather than trusting response order.
    for (const item of [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
      const vector = item.embedding;
      if (!vector || vector.length !== embedding.dimensions) {
        throw new Error(
          `Voyage returned a ${vector?.length ?? 0}-dimension vector, expected ${embedding.dimensions}. Check EMBEDDING_MODEL.`,
        );
      }
      vectors.push(vector);
    }

    stats.requests += 1;
    stats.totalTokens += response.usage?.totalTokens ?? 0;
  }

  return { vectors, stats };
}

export async function embedDocuments(
  texts: string[],
): Promise<{ vectors: number[][]; stats: EmbedStats }> {
  if (texts.length === 0) return { vectors: [], stats: { requests: 0, totalTokens: 0 } };
  return embedAll(texts, "document");
}

export async function embedQuery(text: string): Promise<number[]> {
  const { vectors } = await embedAll([text], "query");
  return vectors[0];
}
