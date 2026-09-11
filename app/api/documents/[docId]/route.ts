import { NextResponse } from "next/server";

import { assertConfig } from "@/lib/config";
import { deleteDocument } from "@/lib/qdrant";

export const runtime = "nodejs";

export async function DELETE(_request: Request, context: { params: Promise<{ docId: string }> }) {
  try {
    assertConfig();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  const { docId } = await context.params;
  if (!docId) {
    return NextResponse.json({ error: "No document id given." }, { status: 400 });
  }

  try {
    const existed = await deleteDocument(docId);
    if (!existed) {
      return NextResponse.json({ error: "Nothing is indexed yet." }, { status: 404 });
    }

    console.log(JSON.stringify({ event: "delete", docId }));
    return NextResponse.json({ docId });
  } catch (error) {
    console.error("delete failed", error);
    return NextResponse.json(
      { error: `Delete failed: ${(error as Error).message}` },
      { status: 500 },
    );
  }
}
