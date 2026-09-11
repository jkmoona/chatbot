import { QdrantClient } from "@qdrant/js-client-rest";

import { embedding, qdrant } from "./config";

let client: QdrantClient | undefined;

function getClient(): QdrantClient {
  if (!client) {
    client = new QdrantClient({ url: qdrant.url, apiKey: qdrant.apiKey });
  }
  return client;
}

export type ChunkPayload = {
  text: string;
  docId: string;
  filename: string;
  pageNumber: number;
  chunkIndex: number;
};

export type Match = ChunkPayload & {
  id: string;
  score: number;
};

export type IndexedDocument = {
  docId: string;
  filename: string;
  pages: number;
  chunks: number;
};

/**
 * Deleting by docId filters on the payload, and Qdrant rejects a filter on an
 * unindexed field. Creating an index that already exists is a no-op.
 */
async function ensureDocIdIndex(): Promise<void> {
  await getClient().createPayloadIndex(qdrant.collection, {
    field_name: "docId",
    field_schema: "keyword",
    wait: true,
  });
}

/** Idempotent, so ingest can call it every time. */
export async function ensureCollection(): Promise<void> {
  const { exists } = await getClient().collectionExists(qdrant.collection);

  if (!exists) {
    await getClient().createCollection(qdrant.collection, {
      vectors: { size: embedding.dimensions, distance: "Cosine" },
    });
  }

  await ensureDocIdIndex();
}

export async function upsertChunks(
  payloads: ChunkPayload[],
  vectors: number[][],
): Promise<number> {
  if (payloads.length !== vectors.length) {
    throw new Error(`Got ${payloads.length} payloads for ${vectors.length} vectors.`);
  }
  if (payloads.length === 0) return 0;

  const points = payloads.map((payload, index) => ({
    id: crypto.randomUUID(),
    vector: vectors[index],
    payload,
  }));

  await getClient().upsert(qdrant.collection, { wait: true, points });
  return points.length;
}

function toPayload(raw: Record<string, unknown> | null | undefined): ChunkPayload {
  return {
    text: typeof raw?.text === "string" ? raw.text : "",
    docId: typeof raw?.docId === "string" ? raw.docId : "",
    filename: typeof raw?.filename === "string" ? raw.filename : "unknown",
    pageNumber: typeof raw?.pageNumber === "number" ? raw.pageNumber : 0,
    chunkIndex: typeof raw?.chunkIndex === "number" ? raw.chunkIndex : 0,
  };
}

/**
 * Top `topK` nearest neighbours, ranked and unfiltered. Qdrant's own
 * `score_threshold` is not used because the caller logs the rejected scores.
 */
export async function searchChunks(vector: number[], topK: number): Promise<Match[]> {
  const response = await getClient().query(qdrant.collection, {
    query: vector,
    limit: topK,
    with_payload: true,
  });

  return (response.points ?? []).map((point) => ({
    id: String(point.id),
    score: point.score ?? 0,
    ...toPayload(point.payload as Record<string, unknown> | null | undefined),
  }));
}

/** Removes every chunk of one document. Returns false if the collection is absent. */
export async function deleteDocument(docId: string): Promise<boolean> {
  const { exists } = await getClient().collectionExists(qdrant.collection);
  if (!exists) return false;

  // A collection created elsewhere may not have the index yet.
  await ensureDocIdIndex();

  await getClient().delete(qdrant.collection, {
    wait: true,
    filter: { must: [{ key: "docId", match: { value: docId } }] },
  });

  return true;
}

/**
 * One row per uploaded document, aggregated from the stored chunks.
 *
 * The existence check costs a round trip but stays: the client's errors carry no
 * status code, so a missing collection could not otherwise be told apart from a
 * real failure, and it is the normal state before the first upload.
 */
export async function listDocuments(): Promise<IndexedDocument[]> {
  const { exists } = await getClient().collectionExists(qdrant.collection);
  if (!exists) return [];

  const byDoc = new Map<string, { filename: string; pages: Set<number>; chunks: number }>();
  let offset: Awaited<ReturnType<QdrantClient["scroll"]>>["next_page_offset"];

  do {
    const page = await getClient().scroll(qdrant.collection, {
      limit: 256,
      offset,
      with_payload: ["docId", "filename", "pageNumber"],
      with_vector: false,
    });

    for (const point of page.points) {
      const payload = toPayload(point.payload as Record<string, unknown> | null | undefined);
      if (!payload.docId) continue;

      const entry = byDoc.get(payload.docId) ?? {
        filename: payload.filename,
        pages: new Set<number>(),
        chunks: 0,
      };
      entry.pages.add(payload.pageNumber);
      entry.chunks += 1;
      byDoc.set(payload.docId, entry);
    }

    offset = page.next_page_offset;
  } while (offset !== null && offset !== undefined);

  return [...byDoc.entries()]
    .map(([docId, entry]) => ({
      docId,
      filename: entry.filename,
      pages: entry.pages.size,
      chunks: entry.chunks,
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}
