import { chunking } from "./config";
import type { PdfPage } from "./pdf";

export type Chunk = {
  text: string;
  pageNumber: number;
  chunkIndex: number;
};

export type ChunkOptions = {
  size?: number;
  overlap?: number;
};

const BOUNDARIES: RegExp[] = [
  /\n\s*\n/, // paragraph
  /\n/, // line
  /(?<=[.!?…])\s+/, // sentence
  /\s+/, // word
];

/**
 * Splits text into the largest pieces that fit `size`, preferring the coarsest
 * boundary that works. A word longer than `size` is returned whole rather than
 * sliced, so a chunk never breaks mid-word.
 */
function toUnits(text: string, size: number): string[] {
  function split(value: string, depth: number): string[] {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.length <= size || depth >= BOUNDARIES.length) return [trimmed];

    const parts = trimmed.split(BOUNDARIES[depth]).filter((part) => part.trim().length > 0);
    if (parts.length <= 1) return split(trimmed, depth + 1);

    return parts.flatMap((part) => split(part, depth + 1));
  }

  return split(text, 0);
}

/** Trailing `overlap` characters, advanced to the next word boundary. */
function overlapTail(text: string, overlap: number): string {
  if (overlap <= 0) return "";
  if (text.length <= overlap) return text;

  const tail = text.slice(-overlap);
  const boundary = tail.search(/\s/);
  return boundary === -1 ? "" : tail.slice(boundary + 1).trim();
}

/**
 * Chunks each page separately, so a chunk's page number is always the page its
 * text came from. `chunkIndex` runs across the whole document.
 */
export function chunkPages(pages: PdfPage[], options: ChunkOptions = {}): Chunk[] {
  const size = options.size ?? chunking.size;
  const overlap = Math.min(options.overlap ?? chunking.overlap, Math.floor(size / 2));

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const page of pages) {
    let current = "";
    // True when `current` holds real content rather than only carried overlap.
    let pending = false;

    const flush = () => {
      const text = current.trim();
      if (text.length === 0) return;
      chunks.push({ text, pageNumber: page.pageNumber, chunkIndex: chunkIndex++ });
      current = overlapTail(text, overlap);
      pending = false;
    };

    for (const unit of toUnits(page.text, size)) {
      const joined = current.length === 0 ? unit : `${current}\n${unit}`;

      if (joined.length <= size) {
        current = joined;
        pending = true;
        continue;
      }

      flush();
      // Resume from the carried overlap, unless the unit needs the whole chunk.
      const withOverlap = current.length === 0 ? unit : `${current}\n${unit}`;
      current = withOverlap.length <= size ? withOverlap : unit;
      pending = true;
    }

    if (pending) flush();
  }

  return chunks;
}
