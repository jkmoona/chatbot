import OpenAI from "openai";

// Every model name, endpoint and tuning value lives here and nowhere else.

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const llm = {
  baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
  model: process.env.LLM_MODEL ?? "openai/gpt-oss-120b",
  apiKey: process.env.GROQ_API_KEY ?? "",
  // Reasoning tokens bill as output. Raise to "medium" if answers are shallow.
  reasoningEffort: "low" as const,
  temperature: 0.2,
} as const;

export const embedding = {
  model: process.env.EMBEDDING_MODEL ?? "voyage-4",
  dimensions: 1024,
  // Voyage caps a request at 1000 inputs and 320K tokens; 128 stays inside both.
  batchSize: 128,
  maxBatchTokens: 250_000,
} as const;

export const retrieval = {
  topK: num(process.env.TOP_K, 4),
  /**
   * Set low on purpose. Similarity does not separate a vague but valid question
   * from an off-topic one, so this only skips a pointless model call on empty
   * retrieval; the model decides coverage.
   */
  floor: num(process.env.SCORE_FLOOR, 0.08),
} as const;

export const condensation = {
  /** History messages fed to the rewrite, to bound its cost. */
  historyMessages: 4,
  /** Per-message truncation, so one long answer cannot dominate the rewrite. */
  historyCharCap: 400,
  /** On a reasoning model this budget also covers reasoning tokens. */
  maxTokens: 512,
} as const;

export const chunking = {
  size: num(process.env.CHUNK_SIZE, 1500),
  overlap: num(process.env.CHUNK_OVERLAP, 200),
} as const;

export const qdrant = {
  url: process.env.QDRANT_CLUSTER_ENDPOINT ?? "",
  apiKey: process.env.QDRANT_CLUSTER_API_KEY ?? "",
  collection: process.env.QDRANT_COLLECTION ?? "chatbot_chunks",
} as const;

export const upload = {
  maxBytes: 20 * 1024 * 1024,
  /** Below this, the PDF is a scan; indexing it would store near-empty vectors. */
  minTextChars: 100,
} as const;

/** Names the missing variables. Never includes a value, so it is safe to surface. */
export function assertConfig(): void {
  const missing: string[] = [];
  if (!llm.apiKey) missing.push("GROQ_API_KEY");
  if (!process.env.VOYAGE_API_KEY) missing.push("VOYAGE_API_KEY");
  if (!qdrant.url) missing.push("QDRANT_CLUSTER_ENDPOINT");
  if (!qdrant.apiKey) missing.push("QDRANT_CLUSTER_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`,
    );
  }
}

export function createLlmClient(): OpenAI {
  return new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL });
}
