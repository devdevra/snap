import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadHandler } from '../server/download.mjs';

const ORIGIN = 'https://example.supabase.co';
const USER_ID = 'a30c7eb8-4049-4aee-ae27-57f5b742aa2b';
const VERSION_ID = '086b69e2-e23c-4872-b2ef-35945e063853';
const USER_TOKEN = 'user.header.signature';
const LEGACY_KEY = 'legacy.service.signature';
const PATH = `tenant/${VERSION_ID}/final.mp4`;
const SIGN_PATH = `/storage/v1/object/sign/staycut-deliverables/${PATH}`;
const BODY = { versionId: VERSION_ID, channel: 'instagram', purpose: 'organic' };
const ENV = {
  SUPABASE_URL: ORIGIN,
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_key',
  SUPABASE_SECRET_KEY: 'sb_secret_server_key',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function upstream() {
  return [
    json({ id: USER_ID }),
    json([{ bucket_id: 'staycut-deliverables', object_path: PATH }]),
    json({ signedURL: `/object/sign/staycut-deliverables/${PATH}?token=short-lived` }),
  ];
}

async function invoke({ request = {}, env = ENV, responses = upstream(), fetchImpl, timeoutMs } = {}) {
  const calls = [];
  const transport = fetchImpl ?? (async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(responses.length, 'no unexpected upstream request');
    return responses.shift();
  });
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = JSON.parse(body); },
  };
  await createDownloadHandler({ env, fetchImpl: transport, timeoutMs })({
    method: 'POST',
    headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' },
    body: BODY,
    ...request,
  }, response);
  return { ...response, calls };
}

test('authenticated user authorization precedes a server-only, 60-second signed link', async () => {
  const result = await invoke();
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { url: `${ORIGIN}${SIGN_PATH}?token=short-lived&download=final.mp4`, expiresIn: 60 });
  assert.equal(result.headers['cache-control'], 'no-store, private');
  assert.equal(result.headers.pragma, 'no-cache');
  assert.equal(result.headers.vary, 'Authorization');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.equal(result.calls.length, 3);
  const [auth, rpc, sign] = result.calls;
  assert.equal(auth.url, `${ORIGIN}/auth/v1/user`);
  assert.equal(auth.headers.Authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(rpc.url, `${ORIGIN}/rest/v1/rpc/authorize_asset_download`);
  assert.equal(rpc.headers.apikey, ENV.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(rpc.headers.Authorization, `Bearer ${USER_TOKEN}`);
  assert.deepEqual(JSON.parse(rpc.body), {
    p_version_id: VERSION_ID, p_channel: 'instagram', p_purpose: 'organic',
  });
  assert.equal(sign.url, `${ORIGIN}${SIGN_PATH}`);
  assert.deepEqual(JSON.parse(sign.body), { expiresIn: 60 });
  assert.equal(sign.headers.apikey, ENV.SUPABASE_SECRET_KEY);
  assert.equal(sign.headers.Authorization, undefined, 'new secret keys are not JWT bearer tokens');
  assert.ok(result.calls.every(call => call.redirect === 'error'));
  assert.ok(result.calls.every(call => call.signal instanceof AbortSignal));
  assert.ok(!JSON.stringify(result.body).includes(ENV.SUPABASE_SECRET_KEY));
});

test('legacy public and service-role JWT keys remain supported without changing the user RPC identity', async () => {
  const result = await invoke({ env: {
    SUPABASE_URL: ORIGIN, SUPABASE_ANON_KEY: 'anon.public.signature', SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY,
  } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.calls[0].headers.apikey, 'anon.public.signature');
  assert.equal(result.calls[1].headers.Authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(result.calls[2].headers.apikey, LEGACY_KEY);
  assert.equal(result.calls[2].headers.Authorization, `Bearer ${LEGACY_KEY}`);
});

test('GET, absent or malformed bearer tokens, and wrong media type never reach Supabase', async () => {
  const cases = [
    [{ method: 'GET' }, 405],
    [{ headers: { 'content-type': 'application/json' } }, 401],
    [{ headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' } }, 401],
    [{ headers: { authorization: `Bearer ${USER_TOKEN}\r\nInjected: x` } }, 401],
    [{ headers: { authorization: `Bearer ${'x'.repeat(8193)}` } }, 401],
    [{ headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'text/plain' } }, 415],
  ];
  for (const [request, status] of cases) {
    const result = await invoke({ request });
    assert.equal(result.statusCode, status);
    assert.equal(result.calls.length, 0);
    if (status === 405) assert.equal(result.headers.allow, 'POST');
  }
});

test('caller-supplied paths, actors, URLs, invalid scope, and malformed bodies cannot override authorization', async () => {
  const cases = [
    { ...BODY, object_path: 'other-tenant/private.mp4' },
    { ...BODY, actorId: USER_ID },
    { ...BODY, bucket: 'public' },
    { ...BODY, url: 'https://attacker.example' },
    { ...BODY, channel: 'tiktok' },
    { ...BODY, purpose: 'any' },
    { ...BODY, versionId: '../private' },
    { versionId: VERSION_ID, channel: 'instagram' },
    null, [], '{bad-json',
  ];
  for (const body of cases) {
    const result = await invoke({ request: { body } });
    assert.equal(result.statusCode, 400);
    assert.equal(result.calls.length, 0);
  }
});

test('oversized JSON, declared payloads, and raw streams are rejected before any upstream request', async () => {
  const oversized = await invoke({ request: { body: JSON.stringify({ ...BODY, padding: 'x'.repeat(2048) }) } });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.calls.length, 0);
  const declared = await invoke({ request: { headers: {
    authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json', 'content-length': '999999',
  } } });
  assert.equal(declared.statusCode, 413);
  assert.equal(declared.calls.length, 0);
  const raw = await invoke({ request: {
    body: undefined,
    async *[Symbol.asyncIterator]() { yield Buffer.alloc(2049, 'x'); },
  } });
  assert.equal(raw.statusCode, 413);
  assert.equal(raw.calls.length, 0);
});

test('valid raw JSON request streams use the same authorization flow', async () => {
  const result = await invoke({ request: {
    body: undefined,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(BODY)); },
  } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.calls.length, 3);
});

test('missing and unsafe server configuration yields 503 without network access or key disclosure', async () => {
  for (const env of [
    {}, { ...ENV, SUPABASE_URL: 'http://example.supabase.co' },
    { ...ENV, SUPABASE_URL: `${ORIGIN}/another/path` },
    { ...ENV, SUPABASE_URL: 'https://user:password@example.supabase.co' },
    { ...ENV, SUPABASE_PUBLISHABLE_KEY: undefined },
    { ...ENV, SUPABASE_SECRET_KEY: undefined },
    { ...ENV, SUPABASE_SECRET_KEY: 'not-a-secret-key' },
    { ...ENV, SUPABASE_SECRET_KEY: 'sb_secret_key\nInjected: secret' },
  ]) {
    const result = await invoke({ env });
    assert.equal(result.statusCode, 503);
    assert.equal(result.calls.length, 0);
    assert.deepEqual(result.body, { error: '다운로드 서버 설정이 필요합니다.' });
  }
});

test('unverified or unavailable identity never reaches the authorization RPC or signer', async () => {
  for (const [response, expected] of [
    [json({ message: 'secret upstream details' }, 401), 401],
    [json({ error: 'denied' }, 403), 401],
    [json({ id: 'not-a-user-id' }), 502],
    [json({ error: 'unavailable' }, 503), 502],
  ]) {
    const result = await invoke({ responses: [response] });
    assert.equal(result.statusCode, expected);
    assert.equal(result.calls.length, 1);
    assert.ok(!JSON.stringify(result.body).includes('secret upstream details'));
  }
});

test('tenant and workflow denials never call the privileged signer', async () => {
  const cases = [
    [json({ code: '42501', message: 'cross-tenant details' }, 403), 403],
    [json({ code: '55000', message: 'rights/payment internal state' }, 400), 409],
    [json({ code: '22023' }, 400), 400],
    [json({}, 401), 401],
    [json({}, 500), 502],
    [json([]), 403],
    [json([{ bucket_id: 'other', object_path: PATH }]), 502],
  ];
  for (const [rpc, status] of cases) {
    const result = await invoke({ responses: [json({ id: USER_ID }), rpc] });
    assert.equal(result.statusCode, status);
    assert.equal(result.calls.length, 2);
    assert.ok(!JSON.stringify(result.body).includes('internal state'));
  }
});

test('database object paths cannot inject traversal, encoded separators, query strings, or control characters', async () => {
  for (const object_path of [
    '../private.mp4', '/private.mp4', 'a//b.mp4', 'a/./b.mp4', 'a/../b.mp4',
    'a\\b.mp4', 'a/%2e%2e/b.mp4', 'a/video.mp4?token=bad', 'a/video.mp4#x',
    'a/new\nline.mp4', '', null,
  ]) {
    const result = await invoke({ responses: [json({ id: USER_ID }), json([{ bucket_id: 'staycut-deliverables', object_path }])] });
    assert.equal(result.statusCode, 502);
    assert.equal(result.calls.length, 2);
  }
});

test('signer failure and unsafe returned URLs do not expose a download or upstream error content', async () => {
  const signers = [
    json({ message: ENV.SUPABASE_SECRET_KEY }, 500),
    json({ signedURL: `https://attacker.example${SIGN_PATH}?token=stolen` }),
    json({ signedURL: `//attacker.example${SIGN_PATH}?token=stolen` }),
    json({ signedURL: `${ORIGIN}/storage/v1/object/sign/staycut-deliverables/other.mp4?token=wrong` }),
    json({ signedURL: `${SIGN_PATH}#fragment` }),
    json({ signedURL: SIGN_PATH }),
    json({ signedURL: `${SIGN_PATH}?token=ok\nInjected:x` }),
    json({ signedURL: `${ORIGIN.replace('https:', 'http:')}${SIGN_PATH}?token=unsafe` }),
  ];
  for (const signer of signers) {
    const result = await invoke({ responses: [...upstream().slice(0, 2), signer] });
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.url, undefined);
    assert.ok(!JSON.stringify(result.body).includes(ENV.SUPABASE_SECRET_KEY));
  }
  const sameOrigin = await invoke({ responses: [
    ...upstream().slice(0, 2), json({ signedUrl: `${ORIGIN}${SIGN_PATH}?token=valid` }),
  ] });
  assert.equal(sameOrigin.statusCode, 200);
  assert.equal(new URL(sameOrigin.body.url).searchParams.get('download'), 'final.mp4');
});

test('download response sets a safe basename while preserving the verified token and object path', async () => {
  const unsafeFilenamePath = `tenant/${VERSION_ID}/final\"copy;.mp4`;
  const encodedPath = unsafeFilenamePath.split('/').map(encodeURIComponent).join('/');
  const result = await invoke({ responses: [
    json({ id: USER_ID }),
    json([{ bucket_id: 'staycut-deliverables', object_path: unsafeFilenamePath }]),
    json({ signedURL: `/object/sign/staycut-deliverables/${encodedPath}?token=valid` }),
  ] });
  assert.equal(result.statusCode, 200);
  const url = new URL(result.body.url);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, `/storage/v1/object/sign/staycut-deliverables/${encodedPath}`);
  assert.equal(url.searchParams.get('token'), 'valid');
  assert.equal(url.searchParams.get('download'), 'final_copy_.mp4');
});

test('network errors and aborted requests return safe errors without leaking transport details', async () => {
  const failed = await invoke({ fetchImpl: async () => { throw new Error(`network ${ENV.SUPABASE_SECRET_KEY}`); } });
  assert.equal(failed.statusCode, 502);
  assert.ok(!JSON.stringify(failed.body).includes(ENV.SUPABASE_SECRET_KEY));
  const timeout = await invoke({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('sensitive timeout details')), { once: true });
  }) });
  assert.equal(timeout.statusCode, 504);
  assert.ok(!JSON.stringify(timeout.body).includes('sensitive'));
});
