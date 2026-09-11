import { NextResponse } from "next/server";

import { chunkPages } from "@/lib/chunk";
import { assertConfig, upload } from "@/lib/config";
import { EmbeddingRateLimitError, embedDocuments } from "@/lib/embed";
import { extractPages } from "@/lib/pdf";
import { type ChunkPayload, ensureCollection, upsertChunks } from "@/lib/qdrant";

export const runtime = "nodejs";
// Embedding a long PDF can outlast the default budget.
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    assertConfig();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  let file: File;
  try {
    const form = await request.formData();
    const value = form.get("file");
    if (!(value instanceof File)) {
      return NextResponse.json(
        { error: 'No file was uploaded. Send it as multipart form field "file".' },
        { status: 400 },
      );
    }
    file = value;
  } catch {
    return NextResponse.json(
      { error: "Could not read the upload. Expected multipart/form-data." },
      { status: 400 },
    );
  }

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json(
      { error: `Only PDF files are supported. "${file.name}" is not a PDF.` },
      { status: 415 },
    );
  }

  if (file.size > upload.maxBytes) {
    const limitMb = Math.round(upload.maxBytes / (1024 * 1024));
    // Two decimals, so a file just over the line does not read as exactly the limit.
    const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
    return NextResponse.json(
      { error: `This PDF is ${sizeMb} MB. The limit is ${limitMb} MB.` },
      { status: 413 },
    );
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { pages, totalPages, totalChars } = await extractPages(bytes);

    if (totalChars < upload.minTextChars) {
      return NextResponse.json(
        {
          error:
            `Only ${totalChars} characters of text could be read from this PDF across ` +
            `${totalPages} page(s), so it looks like a scan or an image-only export. ` +
            `OCR is not supported, so nothing was indexed. Upload a PDF with a text layer.`,
        },
        { status: 422 },
      );
    }

    const chunks = chunkPages(pages);
    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "No text chunks could be produced from this PDF. Nothing was indexed." },
        { status: 422 },
      );
    }

    // Before embedding, so a misconfigured collection fails without spending tokens.
    await ensureCollection();

    const { vectors, stats } = await embedDocuments(chunks.map((chunk) => chunk.text));

    const docId = crypto.randomUUID();
    const payloads: ChunkPayload[] = chunks.map((chunk) => ({
      text: chunk.text,
      docId,
      filename: file.name,
      pageNumber: chunk.pageNumber,
      chunkIndex: chunk.chunkIndex,
    }));

    const vectorsStored = await upsertChunks(payloads, vectors);

    // Embedding tokens are the only cost here that grows with input size.
    console.log(
      JSON.stringify({
        event: "ingest",
        docId,
        filename: file.name,
        pagesRead: totalPages,
        chunksMade: chunks.length,
        vectorsStored,
        embeddingRequests: stats.requests,
        embeddingTokens: stats.totalTokens,
      }),
    );

    return NextResponse.json({
      docId,
      filename: file.name,
      pagesRead: totalPages,
      chunksMade: chunks.length,
      vectorsStored,
      embeddingTokens: stats.totalTokens,
    });
  } catch (error) {
    console.error("ingest failed", error);
    if (error instanceof EmbeddingRateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    return NextResponse.json(
      { error: `Ingestion failed: ${(error as Error).message}` },
      { status: 500 },
    );
  }
}
