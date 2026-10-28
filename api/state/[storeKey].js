import { authorized, db, json, readBody, userRow, validStore } from '../../server-lib/state.js';

export default async function handler(req, res) {
  if (req.method !== 'PUT') return json(res, 405, { error: 'method_not_allowed' });
  const identity = await authorized(req, res, true); if (!identity) return;
  const key = req.query.storeKey;
  let body; try { body = await readBody(req, 70 * 1024); } catch (e) { return json(res, e.status || 400, { error: e.status === 413 ? 'payload_too_large' : 'invalid_json' }); }
  if (!body || typeof body !== 'object' || !validStore(key, body.data) || !Number.isSafeInteger(body.revision) || body.revision < 0) return json(res, 400, { error: 'invalid_state' });
  let client;
  try {
    client = await db().connect();
    await client.query('BEGIN');
    const userId = await userRow(client, identity);
    const write = body.revision === 0
      ? await client.query(
        `INSERT INTO user_state (user_id, store_key, data, revision) VALUES ($1, $2, $3::jsonb, 1)
         ON CONFLICT (user_id, store_key) DO NOTHING RETURNING revision, updated_at`,
        [userId, key, JSON.stringify(body.data)],
      )
      : await client.query(
        `UPDATE user_state SET data = $3::jsonb, revision = revision + 1, updated_at = now()
         WHERE user_id = $1 AND store_key = $2 AND revision = $4 RETURNING revision, updated_at`,
        [userId, key, JSON.stringify(body.data), body.revision],
      );
    const { rows } = write;
    if (!rows.length) {
      await client.query('ROLLBACK');
      const current = await client.query('SELECT data, revision, updated_at FROM user_state WHERE user_id = $1 AND store_key = $2', [userId, key]);
      return json(res, 409, { error: 'revision_conflict', current: current.rows[0] ? { data: current.rows[0].data, revision: Number(current.rows[0].revision), updatedAt: current.rows[0].updated_at } : null });
    }
    await client.query('COMMIT');
    json(res, 200, { revision: Number(rows[0].revision), updatedAt: rows[0].updated_at });
  } catch { await client.query('ROLLBACK').catch(() => {}); json(res, 503, { error: 'state_unavailable' }); }
  finally { client?.release(); }
}
