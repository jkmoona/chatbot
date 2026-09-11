import { listDocuments } from "@/lib/qdrant";

import { DeleteButton } from "./delete-button";
import { UploadPanel } from "./upload-panel";

// The collection changes outside the request cycle, so never prerender this.
export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  let documents: Awaited<ReturnType<typeof listDocuments>> = [];
  let error: string | null = null;

  try {
    documents = await listDocuments();
  } catch (cause) {
    error = (cause as Error).message;
  }

  return (
    <>
      <UploadPanel />

      <section className="section">
        <h2>Indexed</h2>

        {error ? (
          <p className="error" role="alert">
            Could not read the collection: {error}
          </p>
        ) : documents.length === 0 ? (
          <p className="dim">Nothing indexed yet.</p>
        ) : (
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
        )}
      </section>
    </>
  );
}
