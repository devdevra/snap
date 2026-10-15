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
const SERVER_RELATIONS = [
  ['tenants', 'id,name,created_at'],
  ['tenant_members', 'tenant_id,user_id,role,active,access_allowed,access_start_date,access_end_date'],
  ['assets', 'id,tenant_id,title,assigned_approver_id,latest_version_id,access_allowed,access_start_date,access_end_date,rights_status,rights_start_date,rights_end_date,allowed_channels,allowed_purposes,final_delivery_paid,created_at'],
  ['asset_versions', 'id,asset_id,tenant_id,version_number,review_status,change_summary,preview_available,delivery_available,object_path,content_sha256,preview_object_path,preview_content_sha256,created_at'],
  ['version_approvals', 'id,version_id,asset_id,tenant_id,actor_id,channel,purpose,content_sha256,rights_start_date,rights_end_date,approved_at'],
  ['revision_requests', 'id,version_id,asset_id,tenant_id,actor_id,message,requested_at,resolved_at'],
];
const BUCKET = 'staycut-deliverables';
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function signingConfig(env) {
  const secret = env.SUPABASE_SECRET_KEY;
  const legacy = env.SUPABASE_SERVICE_ROLE_KEY;
  if (secret !== undefined && secret !== '') {
    return typeof secret === 'string' && secret.length <= 8192 && /^sb_secret_[A-Za-z0-9_-]+$/.test(secret)
      ? { status: 'configured', headers: { apikey: secret } }
      : { status: 'invalid_config' };
  }
  if (legacy !== undefined && legacy !== '') {
    return typeof legacy === 'string' && legacy.length <= 8192 && JWT.test(legacy)
      ? { status: 'configured', headers: { apikey: legacy, Authorization: `Bearer ${legacy}` } }
      : { status: 'invalid_config' };
  }
  return { status: 'not_configured' };
}

function relationStatus(tables) {
  return tables.every(result => result.ok && Array.isArray(result.data) && result.data.length === 0) ? 'ready'
    : tables.some(result => ['PGRST205', '42P01', '42703', 'PGRST204'].includes(result.data?.code)) ? 'missing_schema'
      : tables.some(result => result.data?.code === '42501' || result.status === 401 || result.status === 403)
        ? 'access_restricted' : 'unavailable';
}

function bucketStatus(result) {
  if (result.ok && result.data?.id === BUCKET && result.data.public === false) return 'ready';
  if (result.ok && result.data?.id === BUCKET && result.data.public === true) return 'not_private';
  if (result.status === 401 || result.status === 403) return 'access_restricted';
  if (result.status === 404 || String(result.data?.statusCode) === '404') return 'missing_bucket';
  return 'unavailable';
}

async function probe(fetchImpl, url, headers, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET', headers: { ...headers, Accept: 'application/json' },
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
        serverKeyConfigured: false, serverDatabaseReady: false, serverDatabaseStatus: 'not_configured',
        privateStorageReady: false, privateStorageStatus: 'not_configured',
      }));
    }
    const signing = signingConfig(env);
    const publicHeaders = { apikey: config.publishableKey };
    const [anonymous, privileged] = await Promise.all([
      Promise.all([
        probe(fetchImpl, `${config.supabaseUrl}/auth/v1/settings`, publicHeaders, timeoutMs),
        ...RELATIONS.map(([table, columns]) => probe(fetchImpl,
          `${config.supabaseUrl}/rest/v1/${table}?select=${columns}&limit=0`, publicHeaders, timeoutMs)),
      ]),
      signing.headers ? Promise.all([
        ...SERVER_RELATIONS.map(([table, columns]) => probe(fetchImpl,
          `${config.supabaseUrl}/rest/v1/${table}?select=${columns}&limit=0`, signing.headers, timeoutMs)),
        probe(fetchImpl, `${config.supabaseUrl}/storage/v1/bucket/${BUCKET}`, signing.headers, timeoutMs),
      ]) : null,
    ]);
    const [auth, ...tables] = anonymous;
    const authReady = auth.ok && auth.data !== null && typeof auth.data === 'object'
      && !Array.isArray(auth.data) && auth.data.external !== null
      && typeof auth.data.external === 'object' && !Array.isArray(auth.data.external);
    const databaseStatus = relationStatus(tables);
    const serverDatabaseStatus = privileged ? relationStatus(privileged.slice(0, SERVER_RELATIONS.length)) : signing.status;
    const privateStorageStatus = privileged ? bucketStatus(privileged.at(-1)) : signing.status;
    // Restricted anonymous access is expected for private data, but cannot prove
    // authenticated RPCs or tenant permissions. Privileged probes verify only the
    // selected schema columns and fixed bucket's privacy, never media existence,
    // file content, end-user access, or successful private-link signing.
    response.statusCode = 200;
    response.end(JSON.stringify({
      configured: true, authReady, databaseReady: databaseStatus === 'ready', databaseStatus,
      serverKeyConfigured: Boolean(signing.headers),
      serverDatabaseReady: serverDatabaseStatus === 'ready', serverDatabaseStatus,
      privateStorageReady: privateStorageStatus === 'ready', privateStorageStatus,
    }));
  };
}
