import { Suspense } from "react";

import { listDocuments } from "@/lib/qdrant";

import { DeleteButton } from "./delete-button";
import { UploadPanel } from "./upload-panel";

// The collection changes outside the request cycle, so never prerender this.
export const dynamic = "force-dynamic";

export default function DocumentsPage() {
  return (
    <>
      <UploadPanel />

      <section className="section">
        <h2>Indexed</h2>
        {/* Streamed separately so the upload control is usable before Qdrant answers. */}
        <Suspense fallback={<p className="dim">Loading…</p>}>
          <DocumentList />
        </Suspense>
      </section>
    </>
  );
}

async function DocumentList() {
  let documents: Awaited<ReturnType<typeof listDocuments>> = [];

  try {
    documents = await listDocuments();
  } catch (cause) {
    return (
      <p className="error" role="alert">
        Could not read the collection: {(cause as Error).message}
      </p>
    );
  }

  if (documents.length === 0) {
    return <p className="dim">Nothing indexed yet.</p>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Pages</th>
            <th>Chunks</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.docId}>
              <td>{document.filename}</td>
              <td className="num">{document.pages}</td>
              <td className="num">{document.chunks}</td>
              <td>
                <DeleteButton docId={document.docId} filename={document.filename} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
