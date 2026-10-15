import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigHandler } from '../server/public-config.mjs';
import { createHealthHandler } from '../server/health.mjs';

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_must_never_leave_server',
};
const PUBLIC_ENV = { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: ENV.SUPABASE_PUBLISHABLE_KEY };
const NO_SIGNING = {
  serverKeyConfigured: false, serverDatabaseReady: false, serverDatabaseStatus: 'not_configured',
  privateStorageReady: false, privateStorageStatus: 'not_configured',
};
function json(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
async function invoke(create, options = {}, method = 'GET') {
  const response = {
    headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(raw) { this.raw = raw; this.body = JSON.parse(raw); },
  };
  await create({ env: ENV, ...options })({ method }, response);
  return response;
}

test('config exposes exactly public URL/key and prevents caching', async () => {
  const response = await invoke(createConfigHandler);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { supabaseUrl: ENV.SUPABASE_URL, publishableKey: ENV.SUPABASE_PUBLISHABLE_KEY });
  assert.equal(response.headers['cache-control'], 'no-store, private');
  assert.ok(!response.raw.includes(ENV.SUPABASE_SECRET_KEY));
});

test('config rejects missing, insecure, credential-bearing, or secret-key configuration', async () => {
  for (const env of [{}, { ...ENV, SUPABASE_URL: 'http://project.supabase.co' },
    { ...ENV, SUPABASE_URL: 'https://user:password@project.supabase.co' },
    { ...ENV, SUPABASE_PUBLISHABLE_KEY: ENV.SUPABASE_SECRET_KEY }]) {
    const response = await invoke(createConfigHandler, { env });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(Object.keys(response.body), ['error']);
  }
});

test('only GET is supported and invalid configuration triggers no health requests', async () => {
  for (const create of [createConfigHandler, createHealthHandler]) {
    const response = await invoke(create, {}, 'POST');
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, 'GET');
  }
  const response = await invoke(createHealthHandler, { env: {}, fetchImpl: () => assert.fail('must not fetch') });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.configured, false);
});

test('health uses only read-only zero-row public-key requests and omits upstream details', async () => {
  const calls = [];
  const response = await invoke(createHealthHandler, { env: PUBLIC_ENV, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.includes('/auth/') ? json({ external: { email: true }, secretInternalSetting: 'omit' }) : json([]);
  } });
  assert.deepEqual(response.body, { configured: true, authReady: true, databaseReady: true, databaseStatus: 'ready', ...NO_SIGNING });
  assert.equal(calls.length, 7);
  for (const { url, options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.apikey, ENV.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(options.headers.Authorization, undefined);
    if (url.includes('/rest/')) assert.ok(url.endsWith('&limit=0'));
    assert.equal(options.redirect, 'error');
  }
  assert.ok(!response.raw.includes('omit'));
  assert.ok(!response.raw.includes(ENV.SUPABASE_PUBLISHABLE_KEY));
});

test('missing tables/columns and private permissions are distinct and never claimed ready', async () => {
  for (const [code, status, expected] of [
    ['PGRST205', 404, 'missing_schema'], ['42703', 400, 'missing_schema'],
    ['42501', 401, 'access_restricted'], ['PGRST301', 401, 'access_restricted'],
  ]) {
    const response = await invoke(createHealthHandler, { env: PUBLIC_ENV, fetchImpl: async url => url.includes('/auth/')
      ? json({ external: { email: true } }) : json({ code, message: 'must not disclose' }, status) });
    assert.equal(response.body.databaseReady, false);
    assert.equal(response.body.databaseStatus, expected);
    assert.ok(!response.raw.includes('must not disclose'));
  }
});

test('network failures and malformed upstream payloads safely report unavailable', async () => {
  for (const fetchImpl of [async () => { throw new Error('credentials in error'); }, async () => json({}),
    async () => json({ external: null })]) {
    const response = await invoke(createHealthHandler, { env: PUBLIC_ENV, fetchImpl });
    assert.deepEqual(response.body, { configured: true, authReady: false, databaseReady: false, databaseStatus: 'unavailable', ...NO_SIGNING });
    assert.ok(!response.raw.includes('credentials'));
  }
});

test('slow health dependencies are aborted and report unavailable', async () => {
  let aborted = 0;
  const response = await invoke(createHealthHandler, {
    env: PUBLIC_ENV,
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); }, { once: true });
    }),
  });
  assert.equal(aborted, 7);
  assert.equal(response.body.authReady, false);
  assert.equal(response.body.databaseStatus, 'unavailable');
});

test('privileged probes verify complete zero-row schema and exact private bucket with new-key apikey only', async () => {
  const calls = [];
  const response = await invoke(createHealthHandler, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/auth/')) return json({ external: { email: true }, internal: 'omit-me' });
    if (options.headers.apikey === ENV.SUPABASE_PUBLISHABLE_KEY) return json({ code: '42501' }, 401);
    if (url.includes('/storage/')) return json({ id: 'staycut-deliverables', public: false, name: 'omit-bucket-metadata' });
    return json([]);
  } });
  assert.deepEqual(response.body, {
    configured: true, authReady: true, databaseReady: false, databaseStatus: 'access_restricted',
    serverKeyConfigured: true, serverDatabaseReady: true, serverDatabaseStatus: 'ready',
    privateStorageReady: true, privateStorageStatus: 'ready',
  });
  assert.equal(calls.length, 14);
  const privileged = calls.filter(call => call.options.headers.apikey === ENV.SUPABASE_SECRET_KEY);
  assert.equal(privileged.length, 7);
  for (const { url, options } of privileged) {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.includes('/rest/')) assert.equal(new URL(url).searchParams.get('limit'), '0');
  }
  const versionQuery = privileged.find(call => call.url.includes('/asset_versions?')).url;
  assert.ok(new URL(versionQuery).searchParams.get('select').split(',').includes('preview_object_path'));
  assert.ok(new URL(versionQuery).searchParams.get('select').split(',').includes('preview_content_sha256'));
  assert.equal(privileged.filter(call => call.url.includes('/storage/'))[0].url,
    `${ENV.SUPABASE_URL}/storage/v1/bucket/staycut-deliverables`);
  assert.ok(!response.raw.includes('omit-'));
  assert.ok(!response.raw.includes(ENV.SUPABASE_SECRET_KEY));
  assert.ok(!response.raw.includes(ENV.SUPABASE_PUBLISHABLE_KEY));
});

test('missing or malformed signing keys never produce privileged requests or readiness', async () => {
  for (const secret of [undefined, '', 123, {}, 'sb_publishable_wrong', 'sb_secret_', 'sb_secret_key\nInjected: x', 'sb_secret_a '.trimStart()]) {
    const calls = [];
    const response = await invoke(createHealthHandler, { env: { ...PUBLIC_ENV, SUPABASE_SECRET_KEY: secret },
      fetchImpl: async (url, options) => {
        calls.push(options.headers);
        return url.includes('/auth/') ? json({ external: {} }) : json([]);
      } });
    assert.equal(calls.length, 7);
    assert.ok(calls.every(headers => headers.apikey === ENV.SUPABASE_PUBLISHABLE_KEY));
    assert.equal(response.body.serverKeyConfigured, false);
    assert.equal(response.body.serverDatabaseReady, false);
    assert.equal(response.body.privateStorageReady, false);
    assert.equal(response.body.serverDatabaseStatus, secret === undefined || secret === '' ? 'not_configured' : 'invalid_config');
  }
});

test('rejected server keys and missing privileged schema remain distinct from anonymous status', async () => {
  for (const [code, status, expected] of [['PGRST205', 404, 'missing_schema'], ['42703', 400, 'missing_schema'],
    ['42501', 401, 'access_restricted']]) {
    const response = await invoke(createHealthHandler, { fetchImpl: async (url, options) => {
      if (url.includes('/auth/')) return json({ external: {} });
      if (options.headers.apikey === ENV.SUPABASE_PUBLISHABLE_KEY) return json({ code: '42501' }, 401);
      return json({ code, message: ENV.SUPABASE_SECRET_KEY }, status);
    } });
    assert.equal(response.body.databaseStatus, 'access_restricted');
    assert.equal(response.body.serverDatabaseStatus, expected);
    assert.equal(response.body.serverDatabaseReady, false);
    assert.equal(response.body.privateStorageReady, false);
    assert.ok(!response.raw.includes(ENV.SUPABASE_SECRET_KEY));
  }
});

test('private bucket readiness rejects public, wrong, missing, denied, and malformed buckets', async () => {
  for (const [body, status, expected] of [
    [{ id: 'staycut-deliverables', public: true }, 200, 'not_private'],
    [{ id: 'other-bucket', public: false }, 200, 'unavailable'],
    [{ id: 'staycut-deliverables' }, 200, 'unavailable'],
    [{ statusCode: '404', message: 'private detail' }, 400, 'missing_bucket'],
    [{ message: 'private detail' }, 403, 'access_restricted'],
    [[], 200, 'unavailable'],
  ]) {
    const response = await invoke(createHealthHandler, { fetchImpl: async url => {
      if (url.includes('/auth/')) return json({ external: {} });
      return url.includes('/storage/') ? json(body, status) : json([]);
    } });
    assert.equal(response.body.serverDatabaseReady, true);
    assert.equal(response.body.privateStorageReady, false);
    assert.equal(response.body.privateStorageStatus, expected);
    assert.ok(!response.raw.includes('private detail'));
  }
});

test('privileged rows are never returned or treated as a successful zero-row contract probe', async () => {
  const response = await invoke(createHealthHandler, { fetchImpl: async url => {
    if (url.includes('/auth/')) return json({ external: {} });
    if (url.includes('/storage/')) return json({ id: 'staycut-deliverables', public: false });
    return json([{ id: 'customer-data-must-not-leak' }]);
  } });
  assert.equal(response.body.serverDatabaseReady, false);
  assert.equal(response.body.serverDatabaseStatus, 'unavailable');
  assert.ok(!response.raw.includes('customer-data'));
});

test('privileged timeouts abort all probes without claiming readiness or exposing transport errors', async () => {
  let aborted = 0;
  const response = await invoke(createHealthHandler, { timeoutMs: 5, fetchImpl: async (url, { headers, signal }) => {
    if (headers.apikey === ENV.SUPABASE_PUBLISHABLE_KEY) return url.includes('/auth/') ? json({ external: {} }) : json([]);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted += 1; reject(new Error(ENV.SUPABASE_SECRET_KEY));
    }, { once: true }));
  } });
  assert.equal(aborted, 7);
  assert.equal(response.body.serverDatabaseReady, false);
  assert.equal(response.body.privateStorageReady, false);
  assert.equal(response.body.serverDatabaseStatus, 'unavailable');
  assert.equal(response.body.privateStorageStatus, 'unavailable');
  assert.ok(!response.raw.includes(ENV.SUPABASE_SECRET_KEY));
});

test('legacy service-role signing uses JWT headers only on privileged probes', async () => {
  const legacy = 'legacy.service.signature';
  const response = await invoke(createHealthHandler, {
    env: { ...PUBLIC_ENV, SUPABASE_SERVICE_ROLE_KEY: legacy },
    fetchImpl: async (url, { headers }) => {
      if (headers.apikey === legacy) assert.equal(headers.Authorization, `Bearer ${legacy}`);
      else assert.equal(headers.Authorization, undefined);
      if (url.includes('/auth/')) return json({ external: {} });
      return url.includes('/storage/') ? json({ id: 'staycut-deliverables', public: false }) : json([]);
    },
  });
  assert.equal(response.body.serverDatabaseReady, true);
  assert.equal(response.body.privateStorageReady, true);
  assert.ok(!response.raw.includes(legacy));
});
