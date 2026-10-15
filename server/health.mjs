import { prepareJson, readPublicConfig } from './public-config.mjs';

// Empty queries verify relation/column availability without fetching customer rows.
const RELATIONS = [
  ['tenants', 'id'],
  ['tenant_members', 'tenant_id,user_id'],
  ['assets', 'id,tenant_id'],
  ['asset_versions', 'id,asset_id,tenant_id'],
  ['version_approvals', 'version_id,tenant_id'],
  ['revision_requests', 'version_id,tenant_id'],
];

async function probe(fetchImpl, url, key, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET', headers: { apikey: key, Accept: 'application/json' },
      signal: controller.signal, redirect: 'error',
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 65536) return { ok: false, code: 'unavailable' };
    let data;
    try { data = JSON.parse(raw); } catch { return { ok: false, code: 'unavailable' }; }
    return { ok: response.ok, status: response.status, data };
  } catch { return { ok: false, code: 'unavailable' }; }
  finally { clearTimeout(timeout); }
}

export function createHealthHandler({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  return async function health(request, response) {
    prepareJson(response);
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.statusCode = 405;
      return response.end(JSON.stringify({ error: 'GET 요청만 지원합니다.' }));
    }
    const config = readPublicConfig(env);
    if (!config) {
      response.statusCode = 503;
      return response.end(JSON.stringify({
        configured: false, authReady: false, databaseReady: false, databaseStatus: 'not_configured',
      }));
    }
    const [auth, ...tables] = await Promise.all([
      probe(fetchImpl, `${config.supabaseUrl}/auth/v1/settings`, config.publishableKey, timeoutMs),
      ...RELATIONS.map(([table, columns]) => probe(fetchImpl,
        `${config.supabaseUrl}/rest/v1/${table}?select=${columns}&limit=0`, config.publishableKey, timeoutMs)),
    ]);
    const authReady = auth.ok && auth.data !== null && typeof auth.data === 'object'
      && !Array.isArray(auth.data) && auth.data.external !== null
      && typeof auth.data.external === 'object' && !Array.isArray(auth.data.external);
    const databaseReady = tables.every(result => result.ok && Array.isArray(result.data) && result.data.length === 0);
    const databaseStatus = databaseReady ? 'ready'
      : tables.some(result => ['PGRST205', '42P01', '42703', 'PGRST204'].includes(result.data?.code)) ? 'missing_schema'
        : tables.some(result => result.data?.code === '42501' || result.status === 401 || result.status === 403)
          ? 'access_restricted' : 'unavailable';
    // Restricted anonymous access is expected for private data, but cannot prove
    // authenticated RPCs, tenant permissions, bucket privacy, or media readiness.
    response.statusCode = 200;
    response.end(JSON.stringify({ configured: true, authReady, databaseReady, databaseStatus }));
  };
}
