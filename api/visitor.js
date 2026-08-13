const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

// Coarse, process-local abuse protection. It stores no visitor information;
// it only caps aggregate increment requests handled by a warm function instance.
const INCREMENT_WINDOW_MS = 60 * 1000;
const MAX_INCREMENTS_PER_WINDOW = 30;
let incrementWindowStartedAt = Date.now();
let incrementsInWindow = 0;

function canIncrementNow() {
  const now = Date.now();
  if (now - incrementWindowStartedAt >= INCREMENT_WINDOW_MS) {
    incrementWindowStartedAt = now;
    incrementsInWindow = 0;
  }
  if (incrementsInWindow >= MAX_INCREMENTS_PER_WINDOW) return false;
  incrementsInWindow += 1;
  return true;
}

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
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    await ensureTable();

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const forwardedHost = req.headers['x-forwarded-host'];
      const host = forwardedHost || req.headers.host;
      const expectedOrigin = host ? `https://${host}` : null;
      const isSameOrigin = origin && expectedOrigin && origin === expectedOrigin;
      const isTrackerAction = req.headers['x-ooshie-action'] === 'tracker-use';

      // Restrict increments to deliberate requests from the same-origin tracker UI.
      // No IP address, fingerprint, visitor token, or visit record is stored.
      if (!isSameOrigin || !isTrackerAction) {
        res.status(403).json({ error: 'increment not allowed' });
        return;
      }

      if (!canIncrementNow()) {
        res.setHeader('Retry-After', '60');
        res.status(429).json({ error: 'too many increment requests' });
        return;
      }

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
