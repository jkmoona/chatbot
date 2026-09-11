import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

import { condensation, createLlmClient, llm, retrieval } from "./config";
import { embedQuery } from "./embed";
import { type Match, searchChunks } from "./qdrant";

export type RetrievedChunk = Match;

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

/** Returned verbatim when nothing clears the score floor. */
export const NO_ANSWER = "I could not find this in the uploaded documents";

const CONDENSE_PROMPT = `Rewrite the user's latest message as a standalone question that can be understood without the conversation.

Resolve every pronoun and back-reference ("he", "that project", "what else", "peki") from the conversation. Keep the question in its original language. Add no facts of your own and do not answer it. Output only the rewritten question, on a single line.

If the latest message already stands alone, output it unchanged.`;

/**
 * Rewrites a follow-up into something embeddable: "what else?" carries no
 * meaning on its own. Falls back to the raw question on failure.
 */
async function condenseQuestion(
  question: string,
  history: ChatMessage[],
): Promise<string> {
  if (history.length === 0) return question;

  const conversation = history
    .slice(-condensation.historyMessages)
    .map(
      (message) =>
        `${message.role === "user" ? "User" : "Assistant"}: ${message.content.slice(0, condensation.historyCharCap)}`,
    )
    .join("\n");

  const body: ChatCompletionCreateParamsNonStreaming & { include_reasoning: boolean } = {
    model: llm.model,
    messages: [
      { role: "system", content: CONDENSE_PROMPT },
      { role: "user", content: `Conversation:\n${conversation}\n\nLatest message: ${question}` },
    ],
    temperature: 0,
    reasoning_effort: llm.reasoningEffort,
    max_completion_tokens: condensation.maxTokens,
    include_reasoning: false,
  };

  try {
    const response = await createLlmClient().chat.completions.create(body);
    const rewritten = response.choices[0]?.message?.content?.trim();
    return rewritten && rewritten.length > 0 ? rewritten : question;
  } catch (error) {
    console.warn(JSON.stringify({ event: "condense_failed", error: (error as Error).message }));
    return question;
  }
}

export type Retrieval = {
  chunks: RetrievedChunk[];
  /** The standalone text actually embedded. Differs from the question only for follow-ups. */
  searchQuery: string;
};

/**
 * Retrieval, kept separate from prompting so a reranker can be inserted at the
 * marked line without touching the prompt, the route or the UI.
 */
export async function retrieve(
  question: string,
  history: ChatMessage[] = [],
): Promise<Retrieval> {
  const searchQuery = await condenseQuestion(question, history);
  if (searchQuery !== question) {
    console.log(JSON.stringify({ event: "condense", original: question, rewritten: searchQuery }));
  }

  const vector = await embedQuery(searchQuery);
  const ranked = await searchChunks(vector, retrieval.topK);

  // RERANK SEAM: raise the limit above, reorder `ranked` here.

  const kept = ranked.filter((chunk) => chunk.score >= retrieval.floor);
  logRetrieval(searchQuery, ranked, kept);

  return { chunks: kept, searchQuery };
}

/**
 * Logs what was embedded and every chunk returned, kept or not. Wrong chunks
 * means retrieval is at fault; right chunks means the model is.
 */
function logRetrieval(searchQuery: string, ranked: RetrievedChunk[], kept: RetrievedChunk[]): void {
  console.log(
    JSON.stringify({
      event: "retrieval",
      question: searchQuery,
      topK: retrieval.topK,
      floor: retrieval.floor,
      returned: ranked.length,
      kept: kept.length,
      chunks: ranked.map((chunk) => ({
        id: chunk.id,
        score: Number(chunk.score.toFixed(4)),
        filename: chunk.filename,
        page: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        kept: chunk.score >= retrieval.floor,
      })),
    }),
  );
}

const RULES = `You answer questions about documents that the user has uploaded. Follow these four rules, in this order of priority.

1. LANGUAGE. Answer in the same language as the question, and decide that language from the question alone. The language of the excerpts is irrelevant to your choice. If the question is in Turkish, answer in Turkish even when every excerpt is in English. If the question is in English, answer in English even when every excerpt is in Turkish. Translate the facts you take from the excerpts into the language of the question. Proper nouns stay as written. A question in English about a Turkish document must be answered in English; copying the excerpt's language is the single most common mistake here, so check your first sentence before continuing.

2. GROUNDING. Every fact must come from the supplied excerpts. Never use outside knowledge and never invent a fact the excerpts do not state. You may reason over what the excerpts do state — compare dates, add up durations, weigh strengths, judge how junior or senior someone is — provided every fact you reason from is cited and you make clear which part is your assessment. If the excerpts come from different documents, or describe different people, do not merge them: attribute each fact to its own source, and say so when the question does not make clear which document it means.

When you total up experience, add the length of each stated period separately, and say which kind of experience you are counting. Never treat the gap between the earliest and the latest date as one continuous stretch: two one-month internships a year apart are two months of employment, not one year, and a set of projects scattered across 2022 to 2025 is not "several years of experience". Keep employment, meaning a job or an internship, apart from personal, academic and side projects.

Do not upgrade what the excerpts say. If an excerpt says "developed" or "contributed to", it does not say "led", "owned" or "managed". Do not call experience extensive, senior or deep unless a stated job title or a stated duration supports it. Understating is safer than flattering: someone reading your answer may be deciding whether to interview a real person.

3. CITATION. Cite every claim inline, in exactly this format: [filename p.N] — ordinary ASCII square brackets, the filename as it appears in the excerpt header, then the page. Write [cv.pdf p.1], never a full-width bracket and never a number such as [1] or [2]. A sentence with a fact in it needs a citation. An assessment of your own does not need one, but the facts supporting it do.

4. REFUSAL AND FALSE PREMISES. If the excerpts do not cover the question, say so plainly, in the language of the question, and stop. Do not fill the gap from your own knowledge and do not speculate. When the excerpts are about the right subject but simply lack what was asked, say specifically what is missing rather than refusing everything. And if the question assumes something the excerpts do not support — a technology, a job title, a length of experience, an award — do not accept that assumption in order to be helpful. Say what the excerpts actually show and correct it.

Here is rule 4 in practice.

Excerpts:
--- cv.pdf p.1 ---
"Senior Backend Engineer, Acme Teknoloji, March 2021 - June 2024. Built payment integrations."
Question: "What salary was he paid at Acme?"
Correct answer: "The excerpts do not give any salary information. They state only his role and dates at Acme Teknoloji: Senior Backend Engineer from March 2021 to June 2024 [cv.pdf p.1]."

Notice that the refusal still reports what the excerpts do contain, and still cites it.

Here is a false premise, also rule 4.

Excerpts:
--- cv.pdf p.1 ---
"Backend Developer Intern, Acme Teknoloji, June 2023 - August 2023. Built REST APIs with Django."
Question: "How did he use Kubernetes in his four years at Acme?"
Correct answer: "Two parts of that do not match the excerpts. Kubernetes is not mentioned anywhere; the only technology listed for Acme is Django [cv.pdf p.1]. And the role was a three-month internship, from June to August 2023, not four years [cv.pdf p.1]."

Here is rule 1 in practice, in the direction that is most often got wrong.

Excerpts:
--- ozgecmis.pdf p.2 ---
"Veri Analisti, Marmara Danismanlik, Eylul 2018 - Subat 2020. Musteri raporlarini otomatiklestirdi."
Question: "Where did she work in 2019 and what did she do there?"
Correct answer: "In 2019 she was a Data Analyst at Marmara Danismanlik, where she automated customer reporting [ozgecmis.pdf p.2]."
Wrong answer: "2019 yilinda Marmara Danismanlik sirketinde Veri Analisti olarak calisti [ozgecmis.pdf p.2]."

The second answer is wrong only because of its language. The question was English, so the answer must be English, even though the excerpt was Turkish.`;

/** Built per request: the date is needed to interpret "Present" and judge recency. */
function systemPrompt(): string {
  return `Today's date is ${new Date().toISOString().slice(0, 10)}. Use it whenever a question depends on how recent something is, or when an excerpt describes a period as ongoing.

${RULES}`;
}

/** Labelled, not numbered: an index invites the model to cite "[2]" over the filename. */
function formatExcerpts(chunks: RetrievedChunk[]): string {
  return chunks
    .map((chunk) => `--- ${chunk.filename} p.${chunk.pageNumber} ---\n${chunk.text}`)
    .join("\n\n");
}

/**
 * Prior turns are included so pronouns resolve, but only the excerpts retrieved
 * for the current question are presented as evidence.
 */
export function buildMessages(
  question: string,
  chunks: RetrievedChunk[],
  history: ChatMessage[] = [],
  searchQuery?: string,
): ChatCompletionMessageParam[] {
  // The original wording sets the answer's language; the resolved form stops a
  // bare "what else?" reading as unanswerable.
  const resolved =
    searchQuery && searchQuery !== question
      ? `\n(Resolved from the conversation as: ${searchQuery})`
      : "";

  return [
    { role: "system", content: systemPrompt() },
    ...history,
    {
      role: "user",
      // Repeated last, the position the model weights most heavily.
      content:
        `Excerpts:\n\n${formatExcerpts(chunks)}\n\nQuestion: ${question}${resolved}\n\n` +
        `Answer in the language of the question above, not the language of the excerpts.`,
    },
  ];
}

/**
 * The model sometimes emits full-width brackets, and the citation format is
 * fixed. Both are single code points, so replacing per delta is stream-safe.
 */
function normaliseCitations(text: string): string {
  return text.replaceAll("【", "[").replaceAll("】", "]");
}

/**
 * Yields content deltas only. gpt-oss returns its thinking in a separate
 * `reasoning` field, so this filter keeps it out of the UI even if
 * `include_reasoning: false` is ever ignored.
 */
export async function* answerStream(
  messages: ChatCompletionMessageParam[],
): AsyncGenerator<string> {
  // `include_reasoning` is a Groq extension absent from the OpenAI types; the
  // intersection adds it without weakening the other fields. Never send
  // `reasoning_format` with it, which Groq rejects for gpt-oss.
  const body: ChatCompletionCreateParamsStreaming & { include_reasoning: boolean } = {
    model: llm.model,
    messages,
    temperature: llm.temperature,
    reasoning_effort: llm.reasoningEffort,
    stream: true,
    include_reasoning: false,
  };

  const stream = await createLlmClient().chat.completions.create(body);

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield normaliseCitations(text);
  }
}
