# Document Q&A

Ask questions about an uploaded PDF in Turkish or English. Answers come only from the
document and cite the page they came from, and a Turkish question can be answered from an
English document or the reverse.

Prototype: no authentication, no conversation persistence.

## Stack

Next.js 16 (App Router, TypeScript) · Voyage `voyage-4` embeddings · Qdrant Cloud ·
Groq `openai/gpt-oss-120b` through the OpenAI SDK · `unpdf` · `react-markdown`

## Setup

Needs Node 22+, a Qdrant Cloud cluster, and Voyage and Groq API keys.

```sh
cp .env.example .env   # fill in the four keys
npm install
npm run dev
```

Upload a PDF at `/documents`, then ask about it at `/`.

## Configuration

Everything is read from the environment. No model name, endpoint or tuning value is
hardcoded outside `lib/config.ts`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | — | Key for whichever endpoint `LLM_BASE_URL` points at |
| `VOYAGE_API_KEY` | — | Embeddings |
| `QDRANT_CLUSTER_ENDPOINT` | — | Qdrant Cloud URL |
| `QDRANT_CLUSTER_API_KEY` | — | Qdrant Cloud key |
| `QDRANT_COLLECTION` | `chatbot_chunks` | Created on first upload |
| `LLM_BASE_URL` | Groq | Any OpenAI-compatible endpoint |
| `LLM_MODEL` | `openai/gpt-oss-120b` | Model at that endpoint |
| `EMBEDDING_MODEL` | `voyage-4` | Must produce 1024-dimension vectors |
| `TOP_K` | `4` | Chunks sent to the model |
| `SCORE_FLOOR` | `0.08` | Below this a chunk is dropped before the model sees it |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1500` / `200` | Re-upload documents after changing |

Roughly $0.0005 per question. Groq's free tier allows 8,000 tokens a minute, about three
questions; Voyage's allows 3 requests a minute unless the account has a payment method.

## How it works

**Ingest.** Text is extracted per page, chunked to ~1500 characters with 200 of overlap
(splitting on paragraph, then line, then sentence, then word, never mid-word), embedded, and
upserted with `{text, docId, filename, pageNumber, chunkIndex}`. A PDF yielding under 100
characters is rejected as a scan rather than indexed empty.

**Ask.** A follow-up such as "what else?" is first rewritten into a standalone question, then
embedded and searched by cosine distance. Chunks below `SCORE_FLOOR` are dropped; the rest go
to the model, which streams back NDJSON — sources first, then content deltas.

Three things to know before changing this code:

- `input_type` must be `document` for chunks and `query` for questions. Voyage prepends a
  different instruction for each, and the wrong one degrades retrieval silently. This is also
  what makes cross-lingual retrieval work; there is no translation step.
- `SCORE_FLOOR` is low on purpose. Similarity does not separate a vague but valid question
  from an off-topic one, so the model judges coverage and the floor only avoids a pointless
  call on an empty index.
- gpt-oss returns its reasoning in a separate field. The request sets
  `include_reasoning: false` and the stream forwards only `content`. Never send
  `reasoning_format` alongside it; Groq rejects that combination.

## Diagnosing a bad answer

Every question logs one line naming each chunk returned, kept or not:

```json
{"event":"retrieval","question":"...","topK":4,"floor":0.08,"returned":3,"kept":1,
 "chunks":[{"score":0.4538,"filename":"cv.pdf","page":1,"chunkIndex":0,"kept":true}]}
```

The same scores sit behind the **sources** disclosure under each answer.

| Symptom | Cause |
| --- | --- |
| Wrong chunks retrieved | Retrieval |
| Right chunks, wrong answer | Model |
| Nothing returned at all | Nothing indexed |

A `condense` line shows the rewrite whenever a follow-up was reworded before embedding.

## Deploy

```sh
docker build -t document-qa .
docker run --env-file .env -p 3000:3000 document-qa
```

Railway builds the Dockerfile automatically; `railway.json` pins the builder and adds a
healthcheck. Set the four keys in the service variables. **Do not set `PORT`** — Railway
injects its own, and a value baked into the image shadows it, so every request times out.

## Not built

Authentication, multi-user isolation, conversation persistence, OCR, non-PDF formats,
reranking, tests.

If answer quality needs work, in order:

1. **Reranking.** Retrieve top 20 and rerank to 4 with Voyage `rerank-3-lite`. The insertion
   point is marked `RERANK SEAM` in `lib/rag.ts`, after retrieval and before the prompt.
2. **Model.** Raise `reasoning_effort` to `"medium"` in `lib/config.ts`, or point
   `LLM_BASE_URL` and `LLM_MODEL` at another OpenAI-compatible endpoint.
