import { authorized, db, json, userRow, STORE_KEYS } from '../server-lib/state.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
  const identity = await authorized(req, res); if (!identity) return;
  try {
    const client = await db().connect();
    try {
      const userId = await userRow(client, identity);
      const { rows } = await client.query('SELECT store_key, data, revision, updated_at FROM user_state WHERE user_id = $1 AND store_key = ANY($2)', [userId, [...STORE_KEYS]]);
      json(res, 200, { stores: rows.map((r) => ({ key: r.store_key, data: r.data, revision: Number(r.revision), updatedAt: r.updated_at })) });
    } finally { client.release(); }
  } catch { json(res, 503, { error: 'state_unavailable' }); }
}
