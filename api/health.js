import { db } from '../server-lib/state.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { rows } = await db().query(`
      SELECT
        to_regclass('public.app_users') IS NOT NULL AS app_users,
        to_regclass('public.user_state') IS NOT NULL AS user_state,
        to_regclass('public.migration_receipts') IS NOT NULL AS migration_receipts
    `);
    const schemaReady = Object.values(rows[0]).every(Boolean);
    res.status(200).json({ ok: true, database: 'connected', schemaReady });
  } catch {
    // Keep connection strings and database errors out of the public response.
    res.status(503).json({ ok: false, database: 'unavailable', schemaReady: false });
  }
}
