// Adds embeddings to memories that don't have one for the current model.
//
//   npm run brain:backfill            rows saved while Ollama was down (embedding IS NULL)
//   npm run brain:backfill -- --reembed   also rows embedded with a different EMBED_MODEL
//
// Switching to a model with a different vector size also needs a schema
// change first (ALTER TABLE memories ALTER COLUMN embedding TYPE vector(N),
// after clearing old vectors, and rebuilding the HNSW index).

import { getPool } from "./db";
import { EMBED_DIMS, EMBED_MODEL, embed, vectorLiteral } from "./embeddings";

const BATCH = 50;

async function main() {
  const reembed = process.argv.includes("--reembed");
  const pool = getPool();
  try {
    const col = await pool.query(
      `SELECT atttypmod AS dims FROM pg_attribute
        WHERE attrelid = 'memories'::regclass AND attname = 'embedding'`,
    );
    if (col.rows[0]?.dims > 0 && col.rows[0].dims !== EMBED_DIMS) {
      throw new Error(`memories.embedding is vector(${col.rows[0].dims}) but EMBED_DIMS=${EMBED_DIMS}. Alter the column first.`);
    }

    const where = reembed
      ? `embedding IS NULL OR embedding_model IS DISTINCT FROM $1`
      : `embedding IS NULL AND $1::text IS NOT NULL`;
    let done = 0, failed = 0;
    const skip = new Set<string>(); // rows that failed this run; don't retry them forever

    for (;;) {
      const { rows } = await pool.query<{ id: string; title: string; content: string }>(
        `SELECT id, title, content FROM memories
          WHERE (${where}) AND NOT (id = ANY($2::uuid[]))
          ORDER BY created_at LIMIT ${BATCH}`,
        [EMBED_MODEL, [...skip]],
      );
      if (rows.length === 0) break;

      for (const r of rows) {
        try {
          const vec = await embed(`${r.title}\n${r.content}`, "document");
          await pool.query(
            `UPDATE memories SET embedding = $2::vector, embedding_model = $3, embedding_dims = $4 WHERE id = $1`,
            [r.id, vectorLiteral(vec), EMBED_MODEL, vec.length],
          );
          done++;
        } catch (err) {
          failed++;
          skip.add(r.id);
          console.error(`  ${r.id}: ${(err as Error).message}`);
        }
      }
      console.log(`embedded ${done}, failed ${failed}`);
    }
    console.log(done + failed === 0 ? "Nothing to embed." : `Finished: ${done} embedded, ${failed} failed.`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
