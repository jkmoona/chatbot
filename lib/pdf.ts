import { extractText, getDocumentProxy } from "unpdf";

export type PdfPage = {
  pageNumber: number;
  text: string;
};

export type PdfExtraction = {
  pages: PdfPage[];
  totalPages: number;
  /** Used by the caller to detect a scanned PDF. */
  totalChars: number;
};

/** Collapses runs of whitespace but keeps blank lines, which mark paragraphs. */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Page numbers are 1-based, so they match what a reader sees. */
export async function extractPages(bytes: Uint8Array): Promise<PdfExtraction> {
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  // mergePages: false returns one string per page.
  const perPage = Array.isArray(text) ? text : [text];

  const pages = perPage.map((raw, index) => ({
    pageNumber: index + 1,
    text: normalise(raw ?? ""),
  }));

  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);

  return { pages, totalPages, totalChars };
}
