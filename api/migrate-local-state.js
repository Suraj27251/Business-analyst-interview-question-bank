import { authorized, db, json, readBody, userRow, validStore } from '../server-lib/state.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const identity = await authorized(req, res, true); if (!identity) return;
  let body; try { body = await readBody(req); } catch (e) { return json(res, e.status || 400, { error: e.status === 413 ? 'payload_too_large' : 'invalid_json' }); }
  if (!body || typeof body !== 'object' || body.version !== 1 || !/^[0-9a-f-]{36}$/i.test(body.migration_id || '') || !body.stores || typeof body.stores !== 'object' || Array.isArray(body.stores)) return json(res, 400, { error: 'invalid_migration' });
  let client;
  try {
    client = await db().connect();
    await client.query('BEGIN');
    const userId = await userRow(client, identity);
    const prior = await client.query('SELECT summary, status FROM migration_receipts WHERE user_id=$1 AND migration_id=$2', [userId, body.migration_id]);
    if (prior.rows[0]?.status === 'completed') { await client.query('COMMIT'); return json(res, 200, { ...prior.rows[0].summary, repeated: true }); }
    const result = { imported: [], conflicting: [], invalid: [], skipped: [] };
    for (const [key, value] of Object.entries(body.stores)) {
      if (!validStore(key, value)) { result.invalid.push(key); continue; }
      const { rows } = await client.query('INSERT INTO user_state (user_id, store_key, data, revision) VALUES ($1,$2,$3::jsonb,1) ON CONFLICT DO NOTHING RETURNING store_key', [userId, key, JSON.stringify(value)]);
      (rows.length ? result.imported : result.conflicting).push(key);
    }
    await client.query(
      `INSERT INTO migration_receipts (user_id, migration_id, status, summary, completed_at) VALUES ($1,$2,'completed',$3::jsonb,now())
       ON CONFLICT (user_id, migration_id) DO UPDATE SET status='completed', summary=EXCLUDED.summary, completed_at=now()`,
      [userId, body.migration_id, JSON.stringify(result)],
    );
    await client.query('COMMIT'); json(res, 200, result);
  } catch { if (client) await client.query('ROLLBACK').catch(() => {}); json(res, 503, { error: 'migration_unavailable' }); }
  finally { client?.release(); }
}
