import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigHandler } from '../server/public-config.mjs';
import { createHealthHandler } from '../server/health.mjs';

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_must_never_leave_server',
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
  const response = await invoke(createHealthHandler, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.includes('/auth/') ? json({ external: { email: true }, secretInternalSetting: 'omit' }) : json([]);
  } });
  assert.deepEqual(response.body, { configured: true, authReady: true, databaseReady: true, databaseStatus: 'ready' });
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
    const response = await invoke(createHealthHandler, { fetchImpl: async url => url.includes('/auth/')
      ? json({ external: { email: true } }) : json({ code, message: 'must not disclose' }, status) });
    assert.equal(response.body.databaseReady, false);
    assert.equal(response.body.databaseStatus, expected);
    assert.ok(!response.raw.includes('must not disclose'));
  }
});

test('network failures and malformed upstream payloads safely report unavailable', async () => {
  for (const fetchImpl of [async () => { throw new Error('credentials in error'); }, async () => json({}),
    async () => json({ external: null })]) {
    const response = await invoke(createHealthHandler, { fetchImpl });
    assert.deepEqual(response.body, { configured: true, authReady: false, databaseReady: false, databaseStatus: 'unavailable' });
    assert.ok(!response.raw.includes('credentials'));
  }
});

test('slow health dependencies are aborted and report unavailable', async () => {
  let aborted = 0;
  const response = await invoke(createHealthHandler, {
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); }, { once: true });
    }),
  });
  assert.equal(aborted, 7);
  assert.equal(response.body.authReady, false);
  assert.equal(response.body.databaseStatus, 'unavailable');
});
