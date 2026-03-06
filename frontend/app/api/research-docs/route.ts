import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
export const dynamic = "force-dynamic";

async function ensureTable(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS research_documents (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      title           TEXT NOT NULL,
      description     TEXT,
      doc_type        TEXT NOT NULL DEFAULT 'note',
      content         TEXT,
      file_path       TEXT,
      file_name       TEXT,
      file_size       INTEGER,
      tags            TEXT[] DEFAULT '{}',
      author          TEXT DEFAULT 'operator'
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_research_docs_created ON research_documents(created_at DESC)`);
}

// GET — list all research documents
export async function GET(req: NextRequest) {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const { rows } = await client.query(
      `SELECT * FROM research_documents ORDER BY created_at DESC`
    );
    return NextResponse.json({ documents: rows });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}

// POST — create a new research document (text note or file upload)
export async function POST(req: NextRequest) {
  const client = await pool.connect();
  try {
    await ensureTable(client);

    const contentType = req.headers.get("content-type") || "";

    // ── File upload (multipart form data) ──
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      const title = (formData.get("title") as string) || "";
      const description = (formData.get("description") as string) || "";
      const tags = (formData.get("tags") as string) || "";

      if (!file) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      if (!title.trim()) {
        return NextResponse.json({ error: "Title is required" }, { status: 400 });
      }

      // Sanitise filename: date prefix + original name
      const datePrefix = new Date().toISOString().slice(0, 10);
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const fileName = `${datePrefix}_${safeName}`;

      // Ensure the research directory exists
      const researchDir = path.join(process.cwd(), "public", "research");
      await mkdir(researchDir, { recursive: true });

      // Write file to disk
      const bytes = await file.arrayBuffer();
      const filePath = path.join(researchDir, fileName);
      await writeFile(filePath, Buffer.from(bytes));

      // Determine doc type from extension
      const ext = path.extname(file.name).toLowerCase();
      const docType = ext === ".pdf" ? "pdf" :
                      ext === ".docx" ? "docx" :
                      ext === ".md" ? "markdown" :
                      ext === ".txt" ? "text" : "file";

      const { rows } = await client.query(`
        INSERT INTO research_documents (title, description, doc_type, file_path, file_name, file_size, tags)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [
        title.trim(),
        description.trim() || null,
        docType,
        `/research/${fileName}`,
        file.name,
        file.size,
        tags ? tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [],
      ]);

      return NextResponse.json({ document: rows[0] });
    }

    // ── Text note (JSON body) ──
    const body = await req.json();
    if (!body.title?.trim()) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }

    const { rows } = await client.query(`
      INSERT INTO research_documents (title, description, doc_type, content, tags)
      VALUES ($1, $2, 'note', $3, $4)
      RETURNING *
    `, [
      body.title.trim(),
      body.description?.trim() || null,
      body.content?.trim() || null,
      body.tags || [],
    ]);

    return NextResponse.json({ document: rows[0] });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}

// DELETE — remove a research document
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const client = await pool.connect();
  try {
    await ensureTable(client);
    const { rows } = await client.query(
      `DELETE FROM research_documents WHERE id = $1 RETURNING *`, [id]
    );
    return NextResponse.json({ deleted: rows[0] || null });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
