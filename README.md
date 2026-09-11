# Document Q&A — RAG prototype

Upload a PDF, ask questions about it in Turkish or English, and get a streamed answer that
cites the page it came from. A Turkish question retrieves from an English document and is
answered in Turkish, and the reverse. Answers come only from the uploaded documents; when
the documents do not cover the question, the model is never called.

This is a throwaway prototype for a demo. The production version will be rebuilt inside the
Halalworld Next.js site, so the answering model is configured entirely through env vars.

## Stack

| Part | Choice |
| --- | --- |
| App | Next.js 16, App Router, TypeScript |
| Embeddings | Voyage `voyage-4`, 1024 dimensions, via `voyageai` |
| Vector store | Qdrant Cloud, via `@qdrant/js-client-rest` |
| Answering | `openai` client pointed at Groq, `openai/gpt-oss-120b`, streamed |
| PDF text | `unpdf` (per-page extraction, no worker or native deps) |
| Styling | Hand-written CSS, no UI dependencies |

## Setup

1. **Configure.** Copy the example file and fill in the four secrets.

   ```sh
   cp .env.example .env
   ```

   You need a Qdrant Cloud cluster (free tier is enough), a Voyage API key and a Groq API
   key. The collection is created automatically on first upload.

2. **Install.**

   ```sh
   npm install
   ```

3. **Run.**

   ```sh
   npm run dev
   ```

   Open <http://localhost:3000>.

There is no `docker-compose.yml`: Qdrant runs in the cloud, so there is no local service to
start.

## Two-minute demo

1. Go to **Documents** and upload a text-based PDF — a CV works well. You get back the
   number of pages read, chunks made and vectors stored.
2. Go to **Chat** and ask about it in English.
3. Ask the same thing in Turkish. The answer comes back in Turkish, citing the same English
   pages.
4. Ask a follow-up: just `what else?`. It resolves against the previous turn.
5. Ask something the document does not mention, or with a false premise ("How did he use
   Kubernetes there?"). It says what the document actually contains instead of playing along.
6. Open **sources retrieved** under any answer to see which chunks were used and their
   similarity scores.
7. Back on **Documents**, use **Remove** to drop a document and all of its chunks.

## How cross-language support works

Two independent mechanisms, which is the thing worth understanding. Retrieval is
language-agnostic by construction; the answer's language is prompt control. Neither involves
a translation step, and nothing in the codebase detects language.

**Finding the text.** `voyage-4` is a multilingual model, so it maps meaning — not words —
into one shared 1024-dimension space. "Which certifications does this person hold?" and
`Sertifikalar: Google Cloud Professional Data Engineer` land near each other because they
mean similar things, not because anything matched a string. Qdrant then compares by cosine
distance, which measures the angle between vectors and ignores magnitude, so an eight-word
question can match a 1500-character chunk without length skewing the result.

**The two `input_type` values.** This is the part that quietly carries retrieval quality.
Voyage prepends a different instruction depending on the value, so the embedding is
asymmetric:

| Call site | `inputType` | What Voyage prepends |
| --- | --- | --- |
| [lib/embed.ts](lib/embed.ts) `embedDocuments` | `"document"` | "Represent the document for retrieval: " |
| [lib/embed.ts](lib/embed.ts) `embedQuery` | `"query"` | "Represent the query for retrieving supporting documents: " |

A question and the passage that answers it are not paraphrases of each other — they have
different shapes. The two prefixes place queries and passages into a compatible geometry, so
"what tools does she use?" sits near a list of tools rather than near other questions about
tools. Passing `"document"` for both is a silent quality loss, not an error, which is why
`embedAll` is private and the only two exported wrappers each fix one value.

**Choosing the answer's language.** Retrieval hands over chunks with no language preference
at all, so the model picks the output language. Left alone it copies the excerpts, which is
exactly the bug described under "Diagnosing a bad answer" below. Rule 1 of the system prompt
in [lib/rag.ts](lib/rag.ts) forces the choice from the question, and the instruction is
repeated at the end of the user message.

Measured consequence: relevant chunks scored 0.269–0.544 whether or not the question matched
the document's language, and every cross-lingual query ranked the correct document first.

## Rate limits

Every question and every upload costs one Voyage embedding request. Voyage's free tier without
a payment method allows only 3 per minute, which is not enough for anyone clicking through the
app; adding a payment method raises it to 2000 and still spends the 200M free token grant
first. Do that before sharing the URL.

The app retries a 429 with backoff of roughly 2s, 4s and 8s, then reports the limit in plain
words. Note ~14s of total backoff cannot outlast a 60-second rate window, so the retry absorbs
a short burst rather than recovering an exhausted quota — failing quickly with an actionable
message beats stalling a demo for a minute.

## Cost

| Item | Price | This demo |
| --- | --- | --- |
| Groq `gpt-oss-120b` | $0.15 / 1M input, $0.60 / 1M output | ~$0.0005 per question |
| Voyage `voyage-4` | 200M free tokens, then $0.06 / 1M | free |
| Qdrant Cloud | free tier | free |

A question sends roughly 2,000 input tokens (system prompt plus four chunks) and returns
about 400 output tokens, counting the low-effort reasoning tokens that bill as output but are
never shown. That is about **$0.54 per 1,000 questions**. Embedding a few-page PDF costs a
few hundred tokens against the free grant.

A follow-up question costs one extra, cheap model call for the rewrite described under
Tuning, and no extra embedding call.

The only figure that can grow without bound is ingestion, so every upload logs its embedding
token count.

## Tuning

Change these in `.env`; none of them are hardcoded anywhere.

| Variable | Default | Effect |
| --- | --- | --- |
| `TOP_K` | 4 | Chunks sent to the model. |
| `SCORE_FLOOR` | 0.08 | Cosine score below which a chunk is dropped before the model sees it. |
| `CHUNK_SIZE` | 1500 | Target chunk length in characters. Re-upload after changing. |
| `CHUNK_OVERLAP` | 200 | Characters carried between chunks. Re-upload after changing. |
| `LLM_BASE_URL` | Groq | Any OpenAI-compatible endpoint. |
| `LLM_MODEL` | `openai/gpt-oss-120b` | Model name at that endpoint. |
| `EMBEDDING_MODEL` | `voyage-4` | Changing this needs a matching vector size. |

### About `SCORE_FLOOR`

An earlier version used a single threshold of 0.23 and refused anything below it without
consulting the model. That was wrong, and the measurements show why. Across 32 logged
questions:

| Question | Top score | Verdict |
| --- | --- | --- |
| `Which technologies does this person know?` | 0.517 | relevant |
| `Does he have any published research?` | 0.212 | relevant |
| `which position could he work in?` | 0.179 | relevant |
| `What is the capital of France?` | 0.182 | off-topic |
| `what else?` | 0.120 | relevant follow-up |
| gibberish (`zxqw plörf gnödli…`) | 0.124 | off-topic |

**Valid questions and off-topic ones occupy the same 0.12–0.19 band, so no threshold
separates them.** `which position could he work in?` scores below `What is the capital of
France?`. A single cutoff either refuses good questions or admits bad ones.

Cosine similarity also has a high noise floor: gibberish still scores 0.124 against a
one-page CV. Similarity to a chunk is simply not the same measurement as "this question can
be answered from this chunk".

So the floor is now set low, at 0.08, and does one narrow job: skip a pointless model call
when retrieval comes back empty. Deciding whether the excerpts actually cover the question is
the model's job, under rule 4 of the system prompt, which it does well — it correctly refuses
"What is the capital of France?" while holding three CV chunks.

Two other things measurement showed:

- **Language pairing did not predict the score.** An English question about the English CV
  scored 0.307, lower than an English question about the Turkish CV at 0.454.
- **Cross-lingual retrieval ranked the right document first in every case.** That is
  `voyage-4` doing the work; there is no translation step.

Re-measure against your own corpus by reading the `score` values out of the retrieval log
below. Raising the floor makes the app refuse more often without consulting the model, which
is rarely what you want; leave it low unless embedding calls are the bottleneck.

### Follow-up questions

A bare follow-up such as `what else?` has no standalone meaning, so embedding it retrieves
nothing useful. Before searching, the app rewrites the latest message into a standalone
question using the conversation, and embeds that instead:

```json
{"event":"condense","original":"what else?",
 "rewritten":"What other details are available about his technology stack?"}
```

The rewrite is used only for retrieval. The answering prompt keeps your original wording, so
the reply matches the language and tone you used, with the resolved form supplied alongside it
so the model does not treat "what else?" as unanswerable.

This costs one extra, cheap model call per follow-up and no extra embedding call, so it does
not consume the Voyage rate limit.

## Answer quality, measured

The chatbot was evaluated as a recruiter would use it: 15 questions against one real CV, in
Turkish and English, across five categories. Four rounds were run, fixing what failed each
time. Final round: **15 of 15 pass.**

| Category | What it tests | Round 1 | Round 4 |
| --- | --- | --- | --- |
| Lookup (4) | Facts stated in the CV | 4/4 | 4/4 |
| Inference (4) | Judgements: seniority, fit, strongest stack | 4/4 | 4/4 |
| Follow-up (2) | `what else?`, `peki eğitimi?` | 1/2 | 2/2 |
| Absence (2) | Facts the CV does not contain | 2/2 | 2/2 |
| Trap (3) | Questions with a false premise | 3/3 | 3/3 |

The trap category matters most, because a recruiter asks leading questions and a confident
wrong answer is worse than a refusal. Asked "How did he use Kubernetes at İGDAŞ?", the app
answers that Kubernetes is not mentioned and reports what the CV does say about that
internship. Asked "He has 5 years of .NET experience, right?", it answers "No", then lists
each dated period separately and totals them.

Four defects the loop found, in the order they were fixed:

1. **Follow-ups were refused.** Fixed by query condensation, above.
2. **Experience was inflated.** "Roughly two years of .NET development" for two one-month
   internships, by treating the span between the earliest and latest date as continuous and
   counting personal projects as employment. Fixed by an explicit counting rule.
3. **Seniority was flattered and invented.** One answer read "he has led complex projects"
   where the CV says "developed" and "collaboratively developed", and called four months of
   internships "extensive experience". Fixed by a rule against upgrading the source's verbs,
   which now returns "strong candidate for a mid-level backend position".
4. **Citations were malformed.** The model cited `[2] p.1` — the excerpt's index rather than
   its filename — because excerpts used to be numbered `[1]`, `[2]`. They are now labelled
   with filename and page only, leaving nothing else to cite.

Two smaller fixes came out of the same rounds. The system prompt now carries **today's date**,
without which the model cannot interpret "Present" or judge recency, and once described a past
project as being in the future. And the model intermittently emitted full-width brackets,
`【cv.pdf p.1】`; three rounds of instruction did not stop it, so the stream now rewrites those
two characters.

To re-run the evaluation, keep questions ~22s apart for the Voyage rate limit and read the
`retrieval` and `condense` log lines alongside each answer.

## Diagnosing a bad answer

When an answer is wrong, the first question is whether retrieval or the model is at fault.
Both halves of that are visible.

**Server log.** Every question writes one JSON line naming each chunk that came back, with
its score, filename, page and whether it passed the threshold:

```json
{"event":"retrieval","question":"...","topK":4,"floor":0.08,"returned":3,"kept":1,
 "chunks":[{"id":"...","score":0.4538,"filename":"cv-tr.pdf","page":1,"chunkIndex":0,"kept":true}]}
```

`returned` versus `kept` separates the two failure modes that look identical from the UI: an
empty collection returns nothing, while a threshold set too high returns chunks and keeps
none.

**UI.** The collapsed **sources retrieved** disclosure under each answer shows the same
chunks and scores to three decimals.

Read them together:

| Symptom | Diagnosis | First move |
| --- | --- | --- |
| Wrong chunks retrieved | Retrieval problem | Add reranking; check the `condense` line for follow-ups |
| Right chunks, wrong answer | Model problem | Raise `reasoning_effort`, or switch model |
| Chunks returned, none kept | Floor too high | Lower `SCORE_FLOOR` |
| Nothing returned at all | Nothing indexed | Check the Documents page |

### A worked example of that classification

During testing, an English question about the Turkish CV came back answered in Turkish. The
retrieval log showed `cv-tr.pdf` ranked first at 0.510 — the correct document. Right chunks,
wrong answer, so a model problem rather than a retrieval one, and no amount of threshold
tuning would have fixed it.

The fix was in the prompt: rule 1 now names this exact direction as the common mistake, a
second worked example demonstrates an English answer drawn from a Turkish excerpt, and the
language instruction is repeated at the end of the user message where the model weights it
most. Both directions have behaved since.

That is the loop this logging exists to support. Without the score and filename in the log,
the obvious guess would have been that retrieval had picked up the wrong CV.

## Docker

```sh
docker build -t document-qa .
docker run --env-file .env -p 3000:3000 document-qa
```

The build needs no API keys. Every credential, endpoint and tuning value is read from the
environment at runtime, so one image serves any model.

## Deploy to Railway

Railway detects the `Dockerfile` and builds it; `railway.json` pins that builder and adds a
healthcheck on `/`, so a failed boot shows as a failed deploy rather than a silent 502.

1. Push this repo to GitHub.
2. In Railway, create a project from the repo.
3. Set four variables in the service's **Variables** tab:
   `GROQ_API_KEY`, `VOYAGE_API_KEY`, `QDRANT_CLUSTER_ENDPOINT`, `QDRANT_CLUSTER_API_KEY`.
   Everything else has a default. The build itself needs no keys.
4. Generate a domain under **Settings → Networking**.

Note that the Dockerfile deliberately does **not** set `PORT`. Railway injects its own and
expects the server to listen on it; a baked-in `PORT` shadows Railway's and every request
times out. `server.js` falls back to 3000 when `PORT` is unset, so local `docker run` is
unaffected.

Two things to know before demoing from Railway:

- **Qdrant is not part of this deployment.** It stays on your Qdrant Cloud cluster, so the
  same index serves both local and deployed instances.
- **Voyage's 3 requests per minute** applies per API key, not per instance. Two people
  clicking at once will hit it. See the rate-limit section above.

## Notes on the model

`gpt-oss-120b` is a reasoning model. On Groq its thinking is returned in a separate
`reasoning` field rather than in `content`, and reasoning tokens bill as output tokens. The
request therefore sets `include_reasoning: false` and `reasoning_effort: "low"`, and the
stream forwards only `content` deltas, so no thinking can reach the UI.

`reasoning_format` is deliberately never sent: Groq documents it as unsupported for gpt-oss
and mutually exclusive with `include_reasoning`.

## Next steps

Deliberately not built, to keep the prototype small:

- Authentication and multi-user isolation
- Conversation persistence — history lives in the browser tab only
- OCR for scanned PDFs, which are rejected with a clear message
- Non-PDF formats
- Any provider abstraction beyond `LLM_BASE_URL` and `LLM_MODEL`
- Arabic-specific handling
- Reranking

Two known limitations left alone:

- The fixed English string `I could not find this in the uploaded documents` is used only
  when nothing clears `SCORE_FLOOR`. In practice that almost never happens with a populated
  index — even gibberish scores 0.124 — so refusals normally come from the model and are
  written in the question's language. The fixed string is effectively a guard for an empty
  collection, which is the one case where it does fire.
- The model writes prose with typographic punctuation, such as a non-breaking hyphen in
  "role‑based". Citation brackets are normalised, but this is not, since replacing it
  everywhere would alter legitimate text.

The two planned first moves, if answer quality disappoints:

### 1. Reranking — the largest retrieval-quality lever

Retrieve the top 20 instead of the top 4, rerank with Voyage `rerank-3-lite`, then keep the
top 4. It is multilingual, costs $0.02 per 1M tokens, and the 200M free token grant applies.

The seam is already in place. `retrieve()` in [lib/rag.ts](lib/rag.ts) returns a ranked chunk
list before any prompt is built, and the insertion point is marked `RERANK SEAM`. Raise the
search limit, rerank, re-apply the floor, and return. Nothing in the prompt, the route or
the UI has to change.

### 2. Model switching

Raise `reasoning_effort` to `"medium"` first — it is one value in
[lib/config.ts](lib/config.ts).

If that is not enough, change only `LLM_BASE_URL` and `LLM_MODEL`:

| Problem | Model | Base URL |
| --- | --- | --- |
| Turkish output is weak | `gemini-3.1-flash-lite` | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| Grounding and citation rules ignored | `gpt-5-mini` | `https://api.openai.com/v1` |

Both speak the OpenAI protocol, so no code changes. Note the API key is read from
`GROQ_API_KEY`, so that variable holds whichever key matches `LLM_BASE_URL`.
