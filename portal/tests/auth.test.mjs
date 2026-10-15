import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalClient, PortalError } from '../auth.js';

const ORIGIN = 'https://customer-project.supabase.co';
const PUBLIC = 'sb_publishable_public-test-key';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdXN0b21lciJ9.signature';
const REFRESHED = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdXN0b21lciJ9.refreshed';
const USER = '11111111-1111-4111-8111-111111111111';
const ASSET = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const TENANT = '44444444-4444-4444-8444-444444444444';
const SESSION_KEY = 'staycut.customer.session.v1';
const fixedNow = 1800000000000;
const tokenData = (token = TOKEN, expires = fixedNow / 1000 + 3600) => ({ access_token: token, refresh_token: 'refresh-token-1', expires_at: expires, user: { id: USER, email: 'customer@example.com' } });
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, async json() { return data; } });
const memory = () => { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

function harness(route, { storage = memory(), config = { supabaseUrl: ORIGIN, publishableKey: PUBLIC } } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/config') return response(200, config);
    if (url === `${ORIGIN}/auth/v1/token?grant_type=password`) return response(200, tokenData());
    return route?.(url, options, calls) ?? response(404, { code: 'missing_mock' });
  };
  return { client: createPortalClient({ fetchImpl, storage, clock: () => fixedNow }), storage, calls };
}

async function signedIn(route, options) { const result = harness(route, options); await result.client.signIn('customer@example.com', 'private password'); return result; }

test('public configuration falls back only on API 404 and never accepts a service secret', async () => {
  const calls = [];
  const client = createPortalClient({ storage: memory(), fetchImpl: async url => {
    calls.push(url); return response(url === '/api/config' ? 404 : 200, { supabaseUrl: ORIGIN, publishableKey: PUBLIC });
  } });
  await client.configure();
  assert.deepEqual(calls, ['/api/config', './public-config.json']);
  const invalid = harness(null, { config: { supabaseUrl: ORIGIN, publishableKey: 'sb_secret_never-public' } });
  await assert.rejects(invalid.client.configure(), error => error instanceof PortalError && error.code === 'setup');
  for (const url of ['http://project.supabase.co', 'https://user:password@project.supabase.co', `${ORIGIN}/private`, `${ORIGIN}?tracking=1`]) {
    await assert.rejects(harness(null, { config: { supabaseUrl: url, publishableKey: PUBLIC } }).client.configure(), { code: 'setup' });
  }
});

test('password sign-in goes only to the configured Auth endpoint; tab storage contains no password', async () => {
  const { client, calls, storage } = await signedIn();
  assert.equal(client.user.id, USER);
  const request = calls.find(call => call.url.includes('grant_type=password'));
  assert.deepEqual(JSON.parse(request.options.body), { email: 'customer@example.com', password: 'private password' });
  assert.equal(request.options.headers.apikey, PUBLIC);
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.cache, 'no-store');
  const saved = storage.getItem(SESSION_KEY);
  assert.equal(saved.includes('private password'), false);
  assert.equal(JSON.parse(saved).origin, ORIGIN);
});

test('authentication failures expose a useful generic message without reflecting server text', async () => {
  const client = createPortalClient({ storage: memory(), fetchImpl: async url => url === '/api/config'
    ? response(200, { supabaseUrl: ORIGIN, publishableKey: PUBLIC })
    : response(400, { error_code: 'invalid_credentials', message: 'do not reflect internal error' }) });
  await assert.rejects(client.signIn('x@example.com', 'wrong'), error => error.code === 'auth' && error.message.includes('이메일과 비밀번호') && !error.message.includes('internal'));
  assert.equal(client.user, undefined);
});

test('restored sessions revalidate the actual user before any customer data request', async () => {
  const storage = memory();
  storage.setItem(SESSION_KEY, JSON.stringify({ origin: ORIGIN, ...tokenData(), user: { id: TENANT, email: 'tampered@example.com' } }));
  const { client, calls } = harness(url => url === `${ORIGIN}/auth/v1/user` ? response(200, { id: USER, email: 'verified@example.com' }) : null, { storage });
  const user = await client.restore();
  assert.deepEqual(user, { id: USER, email: 'verified@example.com' });
  assert.deepEqual(calls.map(call => call.url), ['/api/config', `${ORIGIN}/auth/v1/user`]);
  assert.equal(JSON.parse(storage.getItem(SESSION_KEY)).user.id, USER);
});

test('a saved session from another project is removed without transmitting its token', async () => {
  const storage = memory(); storage.setItem(SESSION_KEY, JSON.stringify({ origin: 'https://other.supabase.co', ...tokenData() }));
  const { client, calls } = harness(null, { storage });
  assert.equal(await client.restore(), null);
  assert.equal(storage.getItem(SESSION_KEY), null);
  assert.equal(calls.length, 1);
});

test('expired sessions refresh once and subsequent RLS reads use the new user JWT', async () => {
  const storage = memory(); storage.setItem(SESSION_KEY, JSON.stringify({ origin: ORIGIN, ...tokenData(TOKEN, fixedNow / 1000 - 5) }));
  const { client, calls } = harness(url => {
    if (url.includes('grant_type=refresh_token')) return response(200, tokenData(REFRESHED));
    if (url.endsWith('/auth/v1/user')) return response(200, { id: USER, email: 'verified@example.com' });
    if (url.includes('/rest/v1/')) return response(200, []);
  }, { storage });
  await client.restore(); await client.listAssets();
  assert.equal(calls.filter(call => call.url.includes('grant_type=refresh_token')).length, 1);
  const dataCalls = calls.filter(call => call.url.includes('/rest/v1/'));
  assert.equal(dataCalls.length, 5);
  assert(dataCalls.every(call => call.options.headers.Authorization === `Bearer ${REFRESHED}`));
  assert(dataCalls.every(call => !call.options.body));
});

test('RLS read joins only latest exact versions and never inserts demo data', async () => {
  const { client, calls } = await signedIn(url => {
    const table = url.split('/rest/v1/')[1]?.split('?')[0];
    const fixtures = {
      tenants: [{ id: TENANT, name: '실제 숙소' }],
      assets: [{ id: ASSET, tenant_id: TENANT, latest_version_id: VERSION, title: '실제 작업' }],
      asset_versions: [{ id: ASSET, asset_id: ASSET, version_number: 1 }, { id: VERSION, asset_id: ASSET, version_number: 2 }],
      version_approvals: [{ version_id: VERSION, approved_at: '2026-10-15T00:00:00Z' }],
      revision_requests: [{ asset_id: ASSET, resolved_at: '2026-10-14T00:00:00Z', message: '이미 처리됨' }],
    };
    return response(200, fixtures[table]);
  });
  const assets = await client.listAssets();
  assert.equal(assets.length, 1); assert.equal(assets[0].version.id, VERSION); assert.equal(assets[0].tenantName, '실제 숙소'); assert.equal(assets[0].revision, undefined);
  assert(calls.filter(call => call.url.includes('/rest/v1/')).every(call => !call.options.method || call.options.method === 'GET'));
  assert(!calls.some(call => JSON.stringify(call).includes('온유')));
});

test('missing schema is distinguished from an unassigned account', async () => {
  const missing = await signedIn(() => response(404, { code: 'PGRST205', message: 'table missing' }));
  await assert.rejects(missing.client.listAssets(), error => error.code === 'setup' && error.message.includes('데이터베이스'));
  const empty = await signedIn(() => response(200, []));
  assert.deepEqual(await empty.client.listAssets(), []);
});

test('approval and revision use caller JWT and exact version RPCs, with feedback never omitted', async () => {
  const { client, calls } = await signedIn(() => response(200, { saved: true }));
  await client.approve(VERSION, 'instagram', 'organic', true, 'unsent feedback');
  await client.revise(VERSION, '객실명 수정');
  const mutations = calls.filter(call => call.url.includes('/rest/v1/rpc/'));
  assert.equal(mutations.length, 2);
  assert.deepEqual(JSON.parse(mutations[0].options.body), { p_version_id: VERSION, p_channel: 'instagram', p_purpose: 'organic', p_confirmed: true, p_feedback: 'unsent feedback' });
  assert.deepEqual(JSON.parse(mutations[1].options.body), { p_version_id: VERSION, p_message: '객실명 수정' });
  assert(mutations.every(call => call.options.headers.Authorization === `Bearer ${TOKEN}`));
  assert(!mutations.some(call => Object.keys(JSON.parse(call.options.body)).some(key => key.includes('actor') || key.includes('tenant'))));
});

test('stale state and permissions never report a successful mutation', async () => {
  for (const [status, code, expected] of [[409, '55000', 'state'], [403, '42501', 'permission']]) {
    const { client } = await signedIn(() => response(status, { code }));
    await assert.rejects(client.approve(VERSION, 'instagram', 'organic', true, ''), { code: expected });
  }
});

test('media APIs receive user JWT and signed URLs are confined to the configured private bucket', async () => {
  const signed = `${ORIGIN}/storage/v1/object/sign/staycut-deliverables/${TENANT}/${ASSET}/${VERSION}/delivery.mp4?token=signed`;
  const { client, calls } = await signedIn(() => response(200, { url: signed, expiresIn: 60 }));
  assert.equal(await client.media('preview', VERSION, 'instagram', 'organic'), signed);
  assert.equal(await client.media('download', VERSION, 'instagram', 'organic'), signed);
  const media = calls.filter(call => call.url.startsWith('/api/') && call.url !== '/api/config');
  assert.deepEqual(JSON.parse(media[0].options.body), { versionId: VERSION });
  assert.deepEqual(JSON.parse(media[1].options.body), { versionId: VERSION, channel: 'instagram', purpose: 'organic' });
  assert(media.every(call => call.options.headers.Authorization === `Bearer ${TOKEN}`));
  for (const url of ['https://attacker.example/file?token=x', `${ORIGIN}/storage/v1/object/public/staycut-deliverables/file.mp4?token=x`, `${ORIGIN}/storage/v1/object/sign/other/file.mp4?token=x`]) {
    const invalid = await signedIn(() => response(200, { url }));
    await assert.rejects(invalid.client.media('preview', VERSION), /파일 링크/);
  }
});

test('failed sign-out still removes the tab session and customer identity', async () => {
  const { client, storage } = await signedIn(() => { throw new Error('network unavailable'); });
  await assert.rejects(client.signOut(), { code: 'network' });
  assert.equal(client.user, undefined); assert.equal(storage.getItem(SESSION_KEY), null);
  await assert.rejects(client.listAssets(), { code: 'auth' });
});
