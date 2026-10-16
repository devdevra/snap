import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewHandler } from '../server/download.mjs';

const ORIGIN = 'https://example.supabase.co';
const USER_ID = 'a30c7eb8-4049-4aee-ae27-57f5b742aa2b';
const VERSION_ID = '086b69e2-e23c-4872-b2ef-35945e063853';
const TENANT_ID = '96216b67-f2ba-409e-a353-582826885df7';
const ASSET_ID = 'fc80c167-4f8b-451a-8b21-6e8be8305f5a';
const USER_TOKEN = 'user.header.signature';
const ENV = { SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test' };
const PATH = `${TENANT_ID}/${ASSET_ID}/${VERSION_ID}/preview/watermarked.mp4`;
const SIGN_PATH = `/storage/v1/object/sign/staycut-deliverables/${PATH}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
function upstream() {
  return [json({ id: USER_ID }), json([{ bucket_id: 'staycut-deliverables', object_path: PATH }]),
    json({ signedURL: `/object/sign/staycut-deliverables/${PATH}?token=preview` })];
}
async function invoke({ request = {}, env = ENV, responses = upstream() } = {}) {
  const calls = [];
  const response = { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(raw) { this.body = JSON.parse(raw); this.raw = raw; } };
  await createPreviewHandler({ env, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(responses.length, 'unexpected upstream call');
    return responses.shift();
  } })({ method: 'POST', headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' },
    body: { versionId: VERSION_ID }, ...request }, response);
  return { ...response, calls };
}

test('preview verifies user and calls preview-only RPC under same identity before signing exact path', async () => {
  const result = await invoke();
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { url: `${ORIGIN}${SIGN_PATH}?token=preview`, expiresIn: 60 });
  assert.equal(new URL(result.body.url).searchParams.has('download'), false);
  assert.equal(result.headers['cache-control'], 'no-store, private');
  assert.equal(result.headers.vary, 'Authorization');
  const [auth, rpc, sign] = result.calls;
  assert.equal(auth.url, `${ORIGIN}/auth/v1/user`);
  assert.equal(auth.headers.Authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(rpc.url, `${ORIGIN}/rest/v1/rpc/authorize_asset_preview`);
  assert.equal(rpc.headers.Authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(rpc.headers.apikey, ENV.SUPABASE_PUBLISHABLE_KEY);
  assert.deepEqual(JSON.parse(rpc.body), { p_version_id: VERSION_ID });
  assert.equal(sign.url, `${ORIGIN}${SIGN_PATH}`);
  assert.deepEqual(JSON.parse(sign.body), { expiresIn: 60 });
  assert.equal(sign.headers.apikey, ENV.SUPABASE_SECRET_KEY);
  assert.equal(sign.headers.Authorization, undefined);
  assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
});

test('preview rejects missing identity and caller-controlled path/actor/scope before upstream access', async () => {
  for (const request of [
    { headers: { 'content-type': 'application/json' } },
    { body: { versionId: VERSION_ID, actorId: USER_ID } },
    { body: { versionId: VERSION_ID, object_path: 'other/private.mp4' } },
    { body: { versionId: VERSION_ID, channel: 'instagram', purpose: 'organic' } },
    { body: { versionId: '../private' } },
  ]) {
    const result = await invoke({ request });
    assert.equal(result.statusCode, request.headers ? 401 : 400);
    assert.equal(result.calls.length, 0);
  }
});

test('missing server signing key safely returns 503 rather than a public media fallback', async () => {
  const result = await invoke({ env: { ...ENV, SUPABASE_SECRET_KEY: undefined } });
  assert.equal(result.statusCode, 503);
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.body, { error: '미리보기 서버 설정이 필요합니다.' });
});

test('unverified users, unauthorized tenants, unavailable latest previews never reach signer', async () => {
  const cases = [
    [[json({}, 401)], 401, 1],
    [[json({ id: 'invalid' })], 502, 1],
    [[json({ id: USER_ID }), json({ code: '42501', message: 'private tenancy details' }, 403)], 403, 2],
    [[json({ id: USER_ID }), json({ code: '55000', message: 'private gate details' }, 400)], 409, 2],
    [[json({ id: USER_ID }), json([])], 403, 2],
  ];
  for (const [responses, status, calls] of cases) {
    const result = await invoke({ responses });
    assert.equal(result.statusCode, status);
    assert.equal(result.calls.length, calls);
    assert.equal(result.body.url, undefined);
    assert.ok(!result.raw.includes('private'));
    if (status === 409) assert.ok(!result.raw.includes('결제'));
  }
});

test('preview enforces fixed private bucket, safe paths, and same-origin exact signed URLs', async () => {
  for (const asset of [{ bucket_id: 'public', object_path: PATH },
    { bucket_id: 'staycut-deliverables', object_path: '../private.mp4' }]) {
    const result = await invoke({ responses: [json({ id: USER_ID }), json([asset])] });
    assert.equal(result.statusCode, 502);
    assert.equal(result.calls.length, 2);
  }
  const result = await invoke({ responses: [...upstream().slice(0, 2),
    json({ signedURL: `https://attacker.example${SIGN_PATH}?token=stolen` })] });
  assert.equal(result.statusCode, 502);
  assert.equal(result.body.url, undefined);
});

test('preview signer never signs delivery originals or a different version preview', async () => {
  for (const object_path of [
    `${TENANT_ID}/${ASSET_ID}/${VERSION_ID}/delivery.mp4`,
    `${TENANT_ID}/${ASSET_ID}/${VERSION_ID}/original/source.mp4`,
    `${TENANT_ID}/${ASSET_ID}/${USER_ID}/preview/watermarked.mp4`,
    `tenant/${ASSET_ID}/${VERSION_ID}/preview/watermarked.mp4`,
    `${TENANT_ID}/asset/${VERSION_ID}/preview/watermarked.mp4`,
  ]) {
    const result = await invoke({ responses: [json({ id: USER_ID }),
      json([{ bucket_id: 'staycut-deliverables', object_path }])] });
    assert.equal(result.statusCode, 502);
    assert.equal(result.calls.length, 2);
    assert.equal(result.body.url, undefined);
  }
});
