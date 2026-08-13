const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS ozzie_counter (
      id TEXT PRIMARY KEY,
      value BIGINT NOT NULL DEFAULT 0
    )
  `;
  await sql`
    INSERT INTO ozzie_counter (id, value)
    VALUES ('unique_visitors', 0)
    ON CONFLICT (id) DO NOTHING
  `;
}

module.exports = async (req, res) => {
  try {
    await ensureTable();

    if (req.method === 'POST') {
      const rows = await sql`
        UPDATE ozzie_counter
        SET value = value + 1
        WHERE id = 'unique_visitors'
        RETURNING value
      `;
      res.status(200).json({ count: Number(rows[0].value) });
      return;
    }

    // GET — just read the current count, no increment
    const rows = await sql`
      SELECT value FROM ozzie_counter WHERE id = 'unique_visitors'
    `;
    res.status(200).json({ count: rows.length ? Number(rows[0].value) : 0 });
  } catch (err) {
    res.status(500).json({ error: 'counter unavailable' });
  }
};
