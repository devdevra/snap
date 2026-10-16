import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOperatorHandler } from '../server/operator.mjs';

const ORIGIN = 'https://example.supabase.co';
const USER_ID = 'a30c7eb8-4049-4aee-ae27-57f5b742aa2b';
const OTHER_ID = '635a629d-72bf-4d12-90c3-850f8a658315';
const TENANT_ID = '96216b67-f2ba-409e-a353-582826885df7';
const ASSET_ID = 'fc80c167-4f8b-451a-8b21-6e8be8305f5a';
const VERSION_ID = '086b69e2-e23c-4872-b2ef-35945e063853';
const SESSION_ID = '8d323527-e69b-484b-947c-1e2dd5da37b2';
const USER_TOKEN = 'user.header.signature';
const BUCKET = 'staycut-deliverables';
const NOW = Date.parse('2026-10-16T03:00:00Z');
const ENV = {
  SUPABASE_URL: ORIGIN,
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_operator_test',
  SUPABASE_SECRET_KEY: 'sb_secret_operator_test',
};
// Real container signatures and hashes make the tests exercise streamed bytes,
// rather than accepting the upload metadata supplied by a caller.
const DELIVERY_BYTES = Buffer.concat([
  Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'),
  Buffer.from('a delivery clip with distinct content'),
]);
const PREVIEW_BYTES = Buffer.concat([
  Buffer.from('1a45dfa3', 'hex'), Buffer.from('webm: a separate, watermarked preview'),
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const TERMS = {
  accessAllowed: true, accessStartDate: '2026-10-01', accessEndDate: '2027-10-01',
  rightsStatus: 'valid', rightsStartDate: '2026-10-01', rightsEndDate: '2027-10-01',
  allowedChannels: ['instagram', 'youtube'], allowedPurposes: ['organic'], finalDeliveryPaid: false,
};
const CONTEXT = { operator: { user_id: USER_ID }, tenants: [], assets: [], members: [] };
const metadata = (bytes, mimeType) => ({ sha256: sha256(bytes), bytes: bytes.length, mimeType });
const PREPARE_INPUT = {
  tenantId: TENANT_ID, assetId: null, title: '10월 숙소 소개 영상', assignedApproverId: OTHER_ID,
  changeSummary: '첫 시안', terms: TERMS,
  delivery: metadata(DELIVERY_BYTES, 'video/mp4'), preview: metadata(PREVIEW_BYTES, 'video/webm'),
};
const PREPARE = { action: 'prepareUpload', ...PREPARE_INPUT };
const COMMIT = { action: 'commitUpload', sessionId: SESSION_ID };
const RESULT = { sessionId: SESSION_ID, tenantId: TENANT_ID, assetId: ASSET_ID, versionId: VERSION_ID, status: 'committed' };
const ADD_MEMBER = { action: 'addMember', tenantId: TENANT_ID, customerEmail: 'customer@example.com',
  accessAllowed: true, accessStartDate: '2026-10-01', accessEndDate: '2027-10-01' };
const UPDATE_MEMBER = { action: 'updateMember', tenantId: TENANT_ID, userId: OTHER_ID, expectedRevision: 7,
  active: false, accessAllowed: false, accessStartDate: '2026-10-01', accessEndDate: '2027-10-01' };
const ASSIGN_APPROVER = { action: 'assignApprover', assetId: ASSET_ID, assignedApproverId: OTHER_ID,
  expectedAssignedApproverId: USER_ID, expectedLatestVersionId: VERSION_ID };
const MEMBER_RESULT = { tenantId: TENANT_ID, userId: OTHER_ID, revision: 8 };
const ASSIGN_RESULT = { assetId: ASSET_ID, assignedApproverId: OTHER_ID, latestVersionId: VERSION_ID };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
function manifest(overrides = {}) {
  return {
    sessionId: SESSION_ID, tenantId: TENANT_ID, assetId: ASSET_ID, versionId: VERSION_ID,
    status: 'prepared', expiresAt: '2026-10-16T04:00:00Z',
    delivery: {
      stagingPath: `staging/${SESSION_ID}/delivery.mp4`,
      finalPath: `${TENANT_ID}/${ASSET_ID}/${VERSION_ID}/delivery.mp4`,
      ...PREPARE_INPUT.delivery,
    },
    preview: {
      stagingPath: `staging/${SESSION_ID}/preview.webm`,
      finalPath: `${TENANT_ID}/${ASSET_ID}/${VERSION_ID}/preview/review.webm`,
      ...PREPARE_INPUT.preview,
    },
    ...overrides,
  };
}
function file(bytes, mimeType, extraHeaders = {}) {
  // Deliberately split the magic bytes and payload across chunks.
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes.subarray(0, 3)));
      controller.enqueue(new Uint8Array(bytes.subarray(3, 11)));
      controller.enqueue(new Uint8Array(bytes.subarray(11)));
      controller.close();
    },
  }), { headers: { 'Content-Type': mimeType, 'Content-Length': String(bytes.length), ...extraHeaders } });
}
const secretCalls = calls => calls.filter(call => call.headers?.apikey === ENV.SUPABASE_SECRET_KEY);
const rpcName = call => new URL(call.url).pathname.split('/rpc/')[1];

async function invoke({ body = { action: 'context' }, request = {}, env = ENV,
  transport, timeoutMs, streamTimeoutMs, totalTimeoutMs, now = () => NOW } = {}) {
  const calls = [];
  const response = {
    headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(raw) { this.raw = raw; this.body = JSON.parse(raw); },
  };
  const fetchImpl = async (url, options = {}) => {
    const call = { url: String(url), ...options };
    calls.push(call);
    if (transport) return transport(call, calls);
    if (new URL(url).pathname === '/auth/v1/user') return json({ id: USER_ID });
    if (rpcName(call) === 'operator_context') return json(CONTEXT);
    assert.fail(`Unexpected upstream request ${options.method} ${url}`);
  };
  await createOperatorHandler({ env, fetchImpl, timeoutMs, streamTimeoutMs, totalTimeoutMs, now })({
    method: 'POST', headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' },
    body: structuredClone(body), ...request,
  }, response);
  return { ...response, calls };
}

function operatorTransport(handle, { context = CONTEXT, auth = { id: USER_ID } } = {}) {
  return async (call, calls) => {
    if (new URL(call.url).pathname === '/auth/v1/user') return json(auth);
    if (rpcName(call) === 'operator_context') return json(context);
    return handle(call, calls);
  };
}

function uploadTransport(uploadManifest = manifest(), signedUrl) {
  return operatorTransport(call => {
    if (rpcName(call) === 'operator_prepare_upload') return json(uploadManifest);
    const pathname = new URL(call.url).pathname;
    if (pathname.startsWith('/storage/v1/object/upload/sign/')) {
      const relative = pathname.replace('/storage/v1', '');
      return json({ url: signedUrl ?? `${relative}?token=upload-${pathname.endsWith('.mp4') ? 'delivery' : 'preview'}` });
    }
    assert.fail(`Unexpected upload request ${call.url}`);
  });
}

function commitTransport({ uploadManifest = manifest(), initialFinals = [],
  fileOverride, moveStatus = 200, finalOverride } = {}) {
  const stored = new Map();
  const contents = new Map([
    [uploadManifest.delivery.stagingPath, [DELIVERY_BYTES, 'video/mp4']],
    [uploadManifest.preview.stagingPath, [PREVIEW_BYTES, 'video/webm']],
  ]);
  const moved = new Set(initialFinals);
  for (const role of ['delivery', 'preview']) {
    const item = uploadManifest[role];
    stored.set(item.finalPath, contents.get(item.stagingPath));
  }
  return operatorTransport(call => {
    const rpc = rpcName(call);
    if (rpc === 'operator_upload_manifest') return json(uploadManifest);
    if (rpc === 'operator_commit_upload') return json(RESULT);
    const pathname = new URL(call.url).pathname;
    if (pathname === '/storage/v1/object/move') {
      const input = JSON.parse(call.body);
      assert.equal(input.bucketId, BUCKET);
      const item = Object.values(uploadManifest).find(value => value?.stagingPath === input.sourceKey);
      assert.ok(item, 'move source must come from the authenticated manifest');
      assert.equal(input.destinationKey, item.finalPath);
      moved.add(item.finalPath);
      return json(moveStatus === 200 ? { message: 'Successfully moved' } : { error: 'already moved' }, moveStatus);
    }
    if (call.method === 'GET' && pathname.startsWith('/storage/v1/object/')) {
      const prefix = pathname.startsWith(`/storage/v1/object/authenticated/${BUCKET}/`)
        ? `/storage/v1/object/authenticated/${BUCKET}/` : `/storage/v1/object/${BUCKET}/`;
      assert.ok(pathname.startsWith(prefix), 'only the fixed private bucket can be read');
      const path = decodeURIComponent(pathname.slice(prefix.length));
      const final = stored.has(path);
      if (final && !moved.has(path)) return json({ error: 'not found' }, 404);
      const entry = (final ? stored : contents).get(path);
      assert.ok(entry, 'object path must come from the authenticated manifest');
      const override = final ? finalOverride : fileOverride;
      if (override) {
        const replaced = override({ path, final, bytes: entry[0], mimeType: entry[1] });
        if (replaced) return replaced;
      }
      return file(...entry);
    }
    assert.fail(`Unexpected commit request ${call.method} ${call.url}`);
  });
}

test('operator context verifies live Auth identity and uses only the user JWT', async () => {
  const result = await invoke();
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, CONTEXT);
  assert.equal(result.headers['cache-control'], 'no-store, private');
  assert.equal(result.headers.vary, 'Authorization');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].url, `${ORIGIN}/auth/v1/user`);
  assert.equal(rpcName(result.calls[1]), 'operator_context');
  assert.deepEqual(JSON.parse(result.calls[1].body), {});
  for (const call of result.calls) {
    assert.equal(call.headers.Authorization, `Bearer ${USER_TOKEN}`);
    assert.equal(call.headers.apikey, ENV.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(call.redirect, 'error');
    assert.ok(call.signal instanceof AbortSignal);
  }
  assert.equal(secretCalls(result.calls).length, 0);
});

test('operator rejects unsupported methods, missing identity and invalid bodies before upstream access', async () => {
  for (const [request, status] of [
    [{ method: 'GET' }, 405],
    [{ headers: { 'content-type': 'application/json' } }, 401],
    [{ headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' } }, 401],
    [{ headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'text/plain' } }, 415],
    [{ body: { action: 'unknown' } }, 400],
    [{ body: { action: 'context', actorId: USER_ID } }, 400],
    [{ body: null }, 400], [{ body: [] }, 400], [{ body: '{invalid' }, 400],
  ]) {
    const result = await invoke({ request });
    assert.equal(result.statusCode, status);
    assert.equal(result.calls.length, 0);
  }
});

test('operator rejects oversized raw request data without authenticating or touching Storage', async () => {
  const result = await invoke({ request: {
    body: undefined,
    async *[Symbol.asyncIterator]() { yield Buffer.alloc(100_000, 'x'); },
  } });
  assert.equal(result.statusCode, 413);
  assert.equal(result.calls.length, 0);
});

test('unverified identity and missing, mismatched or denied operator never reach secret credentials', async () => {
  const cases = [
    [async () => json({ message: ENV.SUPABASE_SECRET_KEY }, 401), 401],
    [async () => json({ id: 'invalid' }), 502],
    [operatorTransport(() => assert.fail(), { context: { ...CONTEXT, operator: null } }), 403],
    [operatorTransport(() => assert.fail(), { context: { ...CONTEXT, operator: { user_id: OTHER_ID } } }), 403],
    [async call => new URL(call.url).pathname === '/auth/v1/user'
      ? json({ id: USER_ID }) : json({ code: '42501', message: 'private operator details' }, 403), 403],
  ];
  for (const [transport, status] of cases) {
    const result = await invoke({ body: PREPARE, transport });
    assert.equal(result.statusCode, status);
    assert.equal(secretCalls(result.calls).length, 0);
    assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
    assert.ok(!result.raw.includes('private operator details'));
  }
});

test('read-only context needs no server secret, and a nonoperator is denied even when that key is absent', async () => {
  const env = { ...ENV, SUPABASE_SECRET_KEY: undefined };
  const context = await invoke({ env });
  assert.equal(context.statusCode, 200);
  assert.deepEqual(context.body, CONTEXT);
  const denied = await invoke({ env, body: PREPARE,
    transport: operatorTransport(() => assert.fail(), { context: { ...CONTEXT, operator: null } }) });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.calls.length, 2);
});

test('createTenant forwards the four explicit fields under the verified user identity', async () => {
  const body = { action: 'createTenant', name: '온유스테이', customerEmail: 'owner@example.com',
    accessStartDate: '2026-10-01', accessEndDate: '2027-10-01' };
  const result = await invoke({ body, transport: operatorTransport(call => {
    assert.equal(rpcName(call), 'operator_create_tenant');
    assert.equal(call.headers.Authorization, `Bearer ${USER_TOKEN}`);
    assert.deepEqual(JSON.parse(call.body), { p_name: body.name, p_customer_email: body.customerEmail,
      p_access_start_date: body.accessStartDate, p_access_end_date: body.accessEndDate });
    return json({ tenantId: TENANT_ID });
  }) });
  assert.equal(result.statusCode, 200);
  assert.equal(secretCalls(result.calls).length, 0);
});

test('member additions normalize email and use only the verified operator JWT without any Storage key', async () => {
  const { action, ...expected } = ADD_MEMBER;
  const result = await invoke({ body: { ...ADD_MEMBER, customerEmail: 'Customer@EXAMPLE.COM' },
    env: { ...ENV, SUPABASE_SECRET_KEY: undefined }, transport: operatorTransport(call => {
      assert.equal(rpcName(call), 'operator_add_member');
      assert.deepEqual(JSON.parse(call.body), { p_input: expected });
      return json({ ...MEMBER_RESULT, member: { privateAudit: 'not part of the public action result' } });
    }) });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, MEMBER_RESULT);
  assert.equal(result.calls.length, 3);
  for (const call of result.calls) {
    assert.equal(call.headers.Authorization, `Bearer ${USER_TOKEN}`);
    assert.equal(call.headers.apikey, ENV.SUPABASE_PUBLISHABLE_KEY);
  }
  assert.equal(secretCalls(result.calls).length, 0);
  assert.ok(!result.raw.includes('privateAudit'));
});

test('member updates preserve explicit revocation, access dates and the observed revision under the operator JWT', async () => {
  for (const body of [UPDATE_MEMBER, { ...UPDATE_MEMBER, active: true, accessAllowed: true }]) {
    const { action, ...expected } = body;
    const result = await invoke({ body, env: { ...ENV, SUPABASE_SECRET_KEY: 'invalid-unused-storage-secret' },
      transport: operatorTransport(call => {
        assert.equal(rpcName(call), 'operator_update_member');
        assert.deepEqual(JSON.parse(call.body), { p_input: expected });
        assert.equal(call.headers.Authorization, `Bearer ${USER_TOKEN}`);
        return json(MEMBER_RESULT);
      }) });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, MEMBER_RESULT);
    assert.equal(result.calls.length, 3);
    assert.equal(secretCalls(result.calls).length, 0);
    assert.ok(!result.calls.some(call => call.url.includes('/storage/') || call.url.includes('/admin/')));
  }
});

test('approver assignment forwards explicit nullable old approver and latest-version guards without Storage credentials', async () => {
  for (const expectedAssignedApproverId of [null, USER_ID]) {
    for (const expectedLatestVersionId of [null, VERSION_ID]) {
      const body = { ...ASSIGN_APPROVER, expectedAssignedApproverId, expectedLatestVersionId };
      const { action, ...expected } = body;
      const result = await invoke({ body, env: { ...ENV, SUPABASE_SECRET_KEY: undefined },
        transport: operatorTransport(call => {
          assert.equal(rpcName(call), 'operator_assign_approver');
          assert.deepEqual(JSON.parse(call.body), { p_input: expected });
          assert.equal(call.headers.Authorization, `Bearer ${USER_TOKEN}`);
          return json({ ...ASSIGN_RESULT, latestVersionId: expectedLatestVersionId });
        }) });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.body, { ...ASSIGN_RESULT, latestVersionId: expectedLatestVersionId });
      assert.equal(result.calls.length, 3);
      assert.equal(secretCalls(result.calls).length, 0);
    }
  }
});

test('member management rejects privilege grants, injected actors, invalid IDs, dates and implicit state changes before authentication', async () => {
  const invalid = [
    ...[ADD_MEMBER, UPDATE_MEMBER, ASSIGN_APPROVER].flatMap(body => [
      { ...body, role: 'owner' }, { ...body, operator: true }, { ...body, actorId: USER_ID },
    ]),
    { ...ADD_MEMBER, tenantId: 'invalid' }, { ...UPDATE_MEMBER, tenantId: null },
    { ...ADD_MEMBER, active: true }, { ...ADD_MEMBER, customerEmail: 'wrong-email' },
    { ...ADD_MEMBER, customerEmail: ' customer@example.com' },
    { ...ADD_MEMBER, customerEmail: `customer@example.com\n${ENV.SUPABASE_SECRET_KEY}` },
    { ...ADD_MEMBER, customerEmail: `${'x'.repeat(250)}@example.com` },
    { ...UPDATE_MEMBER, userId: 'invalid' },
    { ...ASSIGN_APPROVER, assetId: 'invalid' }, { ...ASSIGN_APPROVER, assignedApproverId: null },
    ...[ADD_MEMBER, UPDATE_MEMBER].flatMap(body => [
      { ...body, accessAllowed: 'true' }, { ...body, accessAllowed: undefined },
      { ...body, accessStartDate: '2026-02-30' }, { ...body, accessEndDate: '2027-13-01' },
      { ...body, accessStartDate: null }, { ...body, accessEndDate: undefined },
      { ...body, accessEndDate: '2026-09-30' },
    ]),
    ...[undefined, null, 0, -1, 1.5, '7', 2147483648, Number.MAX_SAFE_INTEGER + 1].map(expectedRevision =>
      ({ ...UPDATE_MEMBER, expectedRevision })),
    ...[undefined, null, 'false', 0].map(active => ({ ...UPDATE_MEMBER, active })),
    ...[undefined, '', false, 'invalid'].flatMap(guard => [
      { ...ASSIGN_APPROVER, expectedAssignedApproverId: guard },
      { ...ASSIGN_APPROVER, expectedLatestVersionId: guard },
    ]),
  ];
  for (const body of invalid) {
    const result = await invoke({ body });
    assert.equal(result.statusCode, 400, `must reject invalid ${body.action} fields`);
    assert.equal(result.calls.length, 0);
    assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
  }
});

test('member operations require all fields including explicit concurrency guards', async () => {
  for (const body of [ADD_MEMBER, UPDATE_MEMBER, ASSIGN_APPROVER]) {
    for (const key of Object.keys(body).filter(key => key !== 'action')) {
      const { [key]: missing, ...withoutField } = body;
      const result = await invoke({ body: withoutField });
      assert.equal(result.statusCode, 400, `${body.action} requires ${key}`);
      assert.equal(result.calls.length, 0);
    }
  }
});

test('no member or assignment mutation occurs when live Auth or the operator gate is denied', async () => {
  for (const body of [ADD_MEMBER, UPDATE_MEMBER, ASSIGN_APPROVER]) {
    for (const [transport, expectedStatus, expectedCalls] of [
      [async () => json({ code: 'invalid_token', message: 'private identity' }, 401), 401, 1],
      [operatorTransport(() => assert.fail('nonoperator must not mutate'),
        { context: { ...CONTEXT, operator: null } }), 403, 2],
      [operatorTransport(() => assert.fail('wrong identity must not mutate'),
        { context: { ...CONTEXT, operator: { user_id: OTHER_ID } } }), 403, 2],
    ]) {
      const result = await invoke({ body, transport });
      assert.equal(result.statusCode, expectedStatus);
      assert.equal(result.calls.length, expectedCalls);
      assert.equal(secretCalls(result.calls).length, 0);
      assert.ok(!result.raw.includes('private identity'));
    }
  }
});

test('stale member revisions, duplicate memberships and changed approvers produce safe explicit state conflicts', async () => {
  for (const body of [ADD_MEMBER, UPDATE_MEMBER, ASSIGN_APPROVER]) {
    for (const code of ['55000', '23505', '23503', '40001']) {
      const result = await invoke({ body, transport: operatorTransport(() => json({ code,
        message: `private other tenant ${ENV.SUPABASE_SECRET_KEY}`, details: 'private auth email', hint: 'private SQL' }, 400)) });
      assert.equal(result.statusCode, 409);
      assert.equal(result.body.code, 'STATE_CONFLICT');
      assert.equal(result.calls.length, 3, 'a failed mutation is never retried or converted into another action');
      assert.equal(secretCalls(result.calls).length, 0);
      assert.ok(!result.raw.includes('private'));
      assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
    }
  }
});

test('member RPC setup, permission and server failures are sanitized without Storage fallback', async () => {
  for (const [reply, status, expectedStatus, expectedCode] of [
    [{ code: 'PGRST202', message: 'private missing function' }, 404, 503, 'CONFIG_REQUIRED'],
    [{ code: '42501', message: 'private account' }, 403, 403, 'OPERATOR_REQUIRED'],
    [{ code: '22023', message: 'private invalid user' }, 400, 400, 'VALIDATION'],
    [{ message: 'private SQL failure' }, 500, 502, 'UPSTREAM'],
  ]) {
    const result = await invoke({ body: UPDATE_MEMBER,
      transport: operatorTransport(() => json({ ...reply, details: ENV.SUPABASE_SECRET_KEY }, status)) });
    assert.equal(result.statusCode, expectedStatus);
    assert.equal(result.body.code, expectedCode);
    assert.equal(result.calls.length, 3);
    assert.equal(secretCalls(result.calls).length, 0);
    assert.ok(!result.raw.includes('private'));
    assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
  }
});

test('malformed or mismatched membership save receipts cannot become a successful management response', async () => {
  for (const [body, replies] of [
    [ADD_MEMBER, [null, [], { ...MEMBER_RESULT, tenantId: OTHER_ID },
      { ...MEMBER_RESULT, userId: 'invalid' }, { ...MEMBER_RESULT, revision: 0 }, { ...MEMBER_RESULT, revision: '8' }]],
    [UPDATE_MEMBER, [{ ...MEMBER_RESULT, userId: USER_ID }, { ...MEMBER_RESULT, revision: 2147483648 }]],
    [ASSIGN_APPROVER, [null, [], { ...ASSIGN_RESULT, assetId: OTHER_ID },
      { ...ASSIGN_RESULT, assignedApproverId: USER_ID }, { ...ASSIGN_RESULT, latestVersionId: 'invalid' },
      { assetId: ASSET_ID, assignedApproverId: OTHER_ID }]],
  ]) {
    for (const reply of replies) {
      const result = await invoke({ body, transport: operatorTransport(() => json(reply)) });
      assert.equal(result.statusCode, 502);
      assert.equal(result.body.code, 'UPSTREAM');
      assert.equal(result.body.tenantId, undefined);
      assert.equal(result.body.assetId, undefined);
      assert.equal(secretCalls(result.calls).length, 0);
    }
  }
});

test('prepareUpload validates contract dates, accepted scopes, file metadata and caller-controlled extras', async () => {
  const invalid = [
    { ...PREPARE, actorId: USER_ID }, { ...PREPARE, objectPath: 'outside/private.mp4' },
    { ...PREPARE, tenantId: 'invalid' }, { ...PREPARE, assetId: '../private' },
    { ...PREPARE, assignedApproverId: 'invalid' }, { ...PREPARE, title: ' ' },
    { ...PREPARE, delivery: { ...PREPARE.delivery, bytes: 0 } },
    { ...PREPARE, delivery: { ...PREPARE.delivery, bytes: 50 * 1024 * 1024 + 1 } },
    { ...PREPARE, delivery: { ...PREPARE.delivery, bytes: 1.5 } },
    { ...PREPARE, delivery: { ...PREPARE.delivery, sha256: 'not-a-hash' } },
    { ...PREPARE, delivery: { ...PREPARE.delivery, mimeType: 'image/png' } },
    { ...PREPARE, delivery: { ...PREPARE.delivery, mimeType: ['video/mp4'] } },
    { ...PREPARE, delivery: { ...PREPARE.delivery, mimeType: {} } },
    { ...PREPARE, delivery: { ...PREPARE.delivery, path: 'private.mp4' } },
    { ...PREPARE, terms: { ...TERMS, rightsStatus: 'unknown' } },
    { ...PREPARE, terms: { ...TERMS, accessAllowed: 'true' } },
    { ...PREPARE, terms: { ...TERMS, allowedChannels: ['tiktok'] } },
    { ...PREPARE, terms: { ...TERMS, allowedPurposes: ['unlimited'] } },
    { ...PREPARE, terms: { ...TERMS, rightsStartDate: '2026-02-31' } },
    { ...PREPARE, terms: { ...TERMS, accessEndDate: '2026-09-01' } },
    { ...PREPARE, terms: { ...TERMS, unknownPrivilege: true } },
  ];
  for (const body of invalid) {
    const result = await invoke({ body });
    assert.equal(result.statusCode, 400);
    assert.equal(result.calls.length, 0);
  }
});

test('prepareUpload signs only two manifest staging paths with server-only keys and upsert disabled', async () => {
  const result = await invoke({ body: PREPARE, transport: uploadTransport() });
  assert.equal(result.statusCode, 200);
  const prepare = result.calls.find(call => rpcName(call) === 'operator_prepare_upload');
  assert.deepEqual(JSON.parse(prepare.body), { p_input: PREPARE_INPUT });
  assert.equal(prepare.headers.Authorization, `Bearer ${USER_TOKEN}`);
  const privileged = secretCalls(result.calls);
  assert.equal(privileged.length, 2);
  for (const [index, role] of ['delivery', 'preview'].entries()) {
    const item = manifest()[role];
    const sign = privileged[index];
    assert.equal(sign.url, `${ORIGIN}/storage/v1/object/upload/sign/${BUCKET}/${item.stagingPath}`);
    assert.equal(sign.method, 'POST');
    assert.equal(sign.headers.Authorization, undefined);
    assert.equal(sign.headers['x-upsert'], 'false');
    assert.deepEqual(JSON.parse(sign.body), {});
    const output = result.body[role];
    assert.equal(new URL(output.url).origin, ORIGIN);
    assert.equal(new URL(output.url).pathname, `/storage/v1/object/upload/sign/${BUCKET}/${item.stagingPath}`);
    assert.equal(output.token, `upload-${role}`);
    assert.equal(output.bytes, item.bytes);
    assert.equal(output.mimeType, item.mimeType);
    assert.equal(output.finalPath, undefined);
    assert.equal(output.stagingPath, undefined);
  }
  for (const field of ['sessionId', 'tenantId', 'assetId', 'versionId', 'status', 'expiresAt']) {
    assert.equal(result.body[field], manifest()[field]);
  }
  assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
});

test('existing-version uploads forward explicit null or UUID latest-version and revision guards unchanged', async () => {
  for (const [expectedLatestVersionId, expectedRevisionId] of [
    [null, null], [null, OTHER_ID], [VERSION_ID, null], [VERSION_ID, OTHER_ID],
  ]) {
    const body = {
      action: 'prepareUpload', tenantId: TENANT_ID, assetId: ASSET_ID,
      expectedLatestVersionId, expectedRevisionId,
      changeSummary: '요청한 자막 수정', delivery: PREPARE.delivery, preview: PREPARE.preview,
    };
    const result = await invoke({ body, transport: uploadTransport() });
    assert.equal(result.statusCode, 200);
    const prepare = result.calls.find(call => rpcName(call) === 'operator_prepare_upload');
    const { action, ...input } = body;
    assert.deepEqual(JSON.parse(prepare.body), { p_input: input });
    assert.equal(prepare.headers.Authorization, `Bearer ${USER_TOKEN}`);
    assert.equal(result.body.assetId, ASSET_ID);
  }
});

test('latest-version and revision guards are required for existing assets and forbidden for new asset uploads', async () => {
  const existing = {
    action: 'prepareUpload', tenantId: TENANT_ID, assetId: ASSET_ID,
    expectedLatestVersionId: VERSION_ID, expectedRevisionId: null,
    changeSummary: '다음 버전', delivery: PREPARE.delivery, preview: PREPARE.preview,
  };
  const { expectedRevisionId: omittedRevision, ...missingRevision } = existing;
  const { expectedLatestVersionId: omittedLatest, ...missingLatest } = existing;
  for (const body of [
    missingRevision, missingLatest,
    ...[undefined, '', 'invalid', false, 0, [], {}].map(expectedRevisionId => ({ ...existing, expectedRevisionId })),
    ...[undefined, '', 'invalid', false, 0, [], {}].map(expectedLatestVersionId => ({ ...existing, expectedLatestVersionId })),
    { ...existing, title: PREPARE.title },
    { ...existing, assignedApproverId: OTHER_ID },
    { ...existing, terms: TERMS },
    { ...PREPARE, expectedRevisionId: null },
    { ...PREPARE, expectedRevisionId: OTHER_ID },
    { ...PREPARE, expectedLatestVersionId: null },
    { ...PREPARE, expectedLatestVersionId: VERSION_ID },
    { ...PREPARE, expectedLatestVersionId: VERSION_ID, expectedRevisionId: null },
  ]) {
    const result = await invoke({ body });
    assert.equal(result.statusCode, 400);
    assert.equal(result.calls.length, 0);
  }
});

test('upload signer rejects off-origin, wrong-path, fragment and tokenless returned links', async () => {
  const expected = `/storage/v1/object/upload/sign/${BUCKET}/${manifest().delivery.stagingPath}`;
  for (const signedUrl of [
    `https://attacker.example${expected}?token=stolen`, `//attacker.example${expected}?token=stolen`,
    `${ORIGIN}${expected.replace('delivery.mp4', 'preview.webm')}?token=wrong`,
    `${expected}?token=ok#fragment`, expected, `${expected}?token=ok\nInjected:secret`,
  ]) {
    const result = await invoke({ body: PREPARE, transport: uploadTransport(manifest(), signedUrl) });
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.delivery, undefined);
    assert.ok(!result.raw.includes('stolen'));
    assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
  }
});

test('malformed or escaped upload manifests never reach a privileged signer', async () => {
  for (const malformed of [
    { ...manifest(), sessionId: OTHER_ID },
    { ...manifest(), delivery: { ...manifest().delivery, stagingPath: `staging/${SESSION_ID}/../delivery.mp4` } },
    { ...manifest(), delivery: { ...manifest().delivery, finalPath: `${OTHER_ID}/${ASSET_ID}/${VERSION_ID}/delivery.mp4` } },
    { ...manifest(), preview: { ...manifest().preview, finalPath: manifest().delivery.finalPath } },
    { ...manifest(), preview: { ...manifest().preview, sha256: PREPARE.delivery.sha256 } },
    { ...manifest(), expiresAt: '2026-10-16T02:00:00Z' },
    [manifest()],
  ]) {
    const result = await invoke({ body: PREPARE, transport: uploadTransport(malformed) });
    assert.ok([409, 502].includes(result.statusCode), `unsafe manifest should fail: ${result.statusCode}`);
    assert.equal(secretCalls(result.calls).length, 0);
  }
});

test('commitUpload accepts only the session ID and derives actor, paths and expected hashes from trusted sources', async () => {
  for (const field of [
    { actorId: OTHER_ID }, { objectPath: 'outside/private.mp4' }, { deliverySha256: '0'.repeat(64) },
    { tenantId: OTHER_ID }, { versionId: OTHER_ID },
  ]) {
    const result = await invoke({ body: { ...COMMIT, ...field } });
    assert.equal(result.statusCode, 400);
    assert.equal(result.calls.length, 0);
  }
  const result = await invoke({ body: COMMIT, transport: commitTransport() });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.assetId, ASSET_ID);
  assert.equal(result.body.versionId, VERSION_ID);
  const getManifest = result.calls.find(call => rpcName(call) === 'operator_upload_manifest');
  assert.deepEqual(JSON.parse(getManifest.body), { p_session_id: SESSION_ID });
  assert.equal(getManifest.headers.Authorization, `Bearer ${USER_TOKEN}`);
  const commit = result.calls.find(call => rpcName(call) === 'operator_commit_upload');
  assert.equal(commit.headers.apikey, ENV.SUPABASE_SECRET_KEY);
  assert.equal(commit.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(commit.body), {
    p_session_id: SESSION_ID, p_actor_id: USER_ID,
    p_delivery_sha256: sha256(DELIVERY_BYTES), p_delivery_bytes: DELIVERY_BYTES.length,
    p_preview_sha256: sha256(PREVIEW_BYTES), p_preview_bytes: PREVIEW_BYTES.length,
  });
  assert.equal(result.calls.filter(call => new URL(call.url).pathname === '/storage/v1/object/move').length, 2);
  assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
  assert.ok(!result.raw.includes('staging/'));
});

test('commit re-verifies promoted final bytes before finalizing the database version', async () => {
  const result = await invoke({ body: COMMIT, transport: commitTransport() });
  assert.equal(result.statusCode, 200);
  const finalIndex = result.calls.findIndex(call => rpcName(call) === 'operator_commit_upload');
  for (const role of ['delivery', 'preview']) {
    const finalPath = manifest()[role].finalPath;
    const reads = result.calls.map((call, index) => ({ call, index })).filter(({ call }) =>
      call.method === 'GET' && call.url.endsWith(`/${finalPath}`));
    assert.equal(reads.length, 2, `${role} final is checked before and after promotion`);
    assert.ok(reads.every(({ index }) => index < finalIndex));
  }
  for (const call of secretCalls(result.calls)) {
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.redirect, 'error');
  }
});

test('already committed upload sessions are idempotent and never touch Storage or finalize again', async () => {
  for (const env of [ENV, { ...ENV, SUPABASE_SECRET_KEY: undefined }]) {
    const result = await invoke({ body: COMMIT, env,
      transport: commitTransport({ uploadManifest: manifest({ status: 'committed' }) }) });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.assetId, ASSET_ID);
    assert.equal(result.body.versionId, VERSION_ID);
    assert.equal(secretCalls(result.calls).length, 0);
  }
});

test('commit cannot accept a delivery reused as its supposedly distinct preview', async () => {
  const duplicateManifest = manifest();
  duplicateManifest.preview = { ...duplicateManifest.preview, sha256: duplicateManifest.delivery.sha256 };
  const result = await invoke({ body: COMMIT, transport: commitTransport({ uploadManifest: duplicateManifest }) });
  assert.ok([409, 502].includes(result.statusCode));
  assert.equal(secretCalls(result.calls).length, 0);
});

test('partially promoted uploads resume from verified finals and move only the remaining staging object', async () => {
  const result = await invoke({ body: COMMIT,
    transport: commitTransport({ initialFinals: [manifest().delivery.finalPath] }) });
  assert.equal(result.statusCode, 200);
  const moves = result.calls.filter(call => new URL(call.url).pathname === '/storage/v1/object/move');
  assert.equal(moves.length, 1);
  assert.equal(JSON.parse(moves[0].body).sourceKey, manifest().preview.stagingPath);
  assert.ok(!result.calls.some(call => call.method === 'GET' && call.url.endsWith(manifest().delivery.stagingPath)));
});

test('concurrent move conflict recovers only when the expected final bytes can be verified', async () => {
  const result = await invoke({ body: COMMIT, transport: commitTransport({ moveStatus: 409 }) });
  assert.equal(result.statusCode, 200);
  assert.ok(result.calls.some(call => rpcName(call) === 'operator_commit_upload'));
});

test('staging hash, actual byte length, content type and container magic mismatches cannot finalize', async () => {
  const cases = [
    ({ bytes, mimeType }) => file(Buffer.concat([bytes.subarray(0, -1), Buffer.from('!')]), mimeType),
    ({ bytes, mimeType }) => file(bytes.subarray(0, -1), mimeType),
    ({ bytes }) => file(bytes, 'application/octet-stream'),
    ({ bytes }) => file(bytes, 'video/webm'),
    ({ bytes, mimeType }) => file(Buffer.alloc(bytes.length, 'x'), mimeType),
  ];
  for (const fileOverride of cases) {
    const result = await invoke({ body: COMMIT, transport: commitTransport({ fileOverride }) });
    assert.ok([409, 422].includes(result.statusCode), `file mismatch should fail: ${result.statusCode}`);
    assert.ok(!result.calls.some(call => rpcName(call) === 'operator_commit_upload'));
    assert.ok(!result.calls.some(call => new URL(call.url).pathname === '/storage/v1/object/move'));
    assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
  }
});

test('a wrong preexisting final is never overwritten or accepted as a successful retry', async () => {
  const result = await invoke({ body: COMMIT, transport: commitTransport({
    initialFinals: [manifest().delivery.finalPath],
    finalOverride: ({ bytes, mimeType }) => file(Buffer.concat([bytes, Buffer.from('tampered')]), mimeType),
  }) });
  assert.ok([409, 422].includes(result.statusCode));
  assert.ok(!result.calls.some(call => rpcName(call) === 'operator_commit_upload'));
  assert.ok(!result.calls.some(call => new URL(call.url).pathname === '/storage/v1/object/move'));
});

test('matching metadata hashes do not bypass MP4 or WebM container validation', async () => {
  for (const role of ['delivery', 'preview']) {
    const bytes = role === 'delivery'
      ? Buffer.from('not-an-mp4-container-with-a-valid-hash')
      : Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('not a web media document')]);
    const validManifest = manifest();
    validManifest[role] = { ...validManifest[role], sha256: sha256(bytes), bytes: bytes.length };
    const result = await invoke({ body: COMMIT, transport: commitTransport({
      uploadManifest: validManifest,
      fileOverride: ({ path, bytes: original, mimeType }) => path === validManifest[role].stagingPath
        ? file(bytes, mimeType) : file(original, mimeType),
    }) });
    assert.ok([409, 422].includes(result.statusCode));
    assert.ok(!result.calls.some(call => rpcName(call) === 'operator_commit_upload'));
  }
});

test('declared file length cannot substitute for the actual streamed byte count', async () => {
  const result = await invoke({ body: COMMIT, transport: commitTransport({
    fileOverride: ({ bytes, mimeType }) => file(bytes, mimeType, { 'Content-Length': String(bytes.length + 1) }),
  }) });
  assert.ok([409, 422].includes(result.statusCode));
  assert.ok(!result.calls.some(call => rpcName(call) === 'operator_commit_upload'));
});

test('tampering between staging verification and the final read prevents database finalization', async () => {
  const result = await invoke({ body: COMMIT, transport: commitTransport({
    finalOverride: ({ bytes, mimeType }) => file(Buffer.concat([bytes.subarray(0, -1), Buffer.from('!')]), mimeType),
  }) });
  assert.ok([409, 422].includes(result.statusCode));
  assert.ok(!result.calls.some(call => rpcName(call) === 'operator_commit_upload'));
});

test('updateAsset only forwards the validated terms to a user-scoped RPC', async () => {
  const body = { action: 'updateAsset', assetId: ASSET_ID, terms: TERMS };
  const result = await invoke({ body, transport: operatorTransport(call => {
    assert.equal(rpcName(call), 'operator_update_asset');
    assert.equal(call.headers.Authorization, `Bearer ${USER_TOKEN}`);
    assert.deepEqual(JSON.parse(call.body), { p_input: { assetId: ASSET_ID, terms: TERMS } });
    return json({ assetId: ASSET_ID });
  }) });
  assert.equal(result.statusCode, 200);
  assert.equal(secretCalls(result.calls).length, 0);
  const invalid = await invoke({ body: { ...body, latestVersionId: VERSION_ID } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.calls.length, 0);
});

test('upstream failures return safe errors without leaking keys or private details', async () => {
  const result = await invoke({ body: PREPARE, transport: operatorTransport(call => {
    assert.equal(rpcName(call), 'operator_prepare_upload');
    return json({ message: `private tenant information ${ENV.SUPABASE_SECRET_KEY}` }, 500);
  }) });
  assert.equal(result.statusCode, 502);
  assert.ok(!result.raw.includes('private tenant information'));
  assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
  assert.equal(secretCalls(result.calls).length, 0);
});

test('request timeouts abort upstream access and return a safe retryable error', async () => {
  const result = await invoke({ timeoutMs: 5, transport: call => new Promise((resolve, reject) => {
    call.signal.addEventListener('abort', () => reject(new Error(`sensitive ${ENV.SUPABASE_SECRET_KEY}`)), { once: true });
  }) });
  assert.equal(result.statusCode, 504);
  assert.equal(result.calls.length, 1);
  assert.ok(!result.raw.includes(ENV.SUPABASE_SECRET_KEY));
  assert.ok(!result.raw.includes('sensitive'));
});

test('the total operation deadline prevents another upstream request after earlier calls exhaust the budget', async () => {
  let checks = 0;
  const result = await invoke({ totalTimeoutMs: 25,
    now: () => checks++ < 2 ? NOW : NOW + 26,
  });
  assert.equal(result.statusCode, 504);
  assert.equal(result.calls.length, 1);
  assert.equal(new URL(result.calls[0].url).pathname, '/auth/v1/user');
  assert.equal(secretCalls(result.calls).length, 0);
});

test('oversized or unsafe server signing keys fail after operator verification without reaching privileged endpoints', async () => {
  for (const secret of [`sb_secret_${'x'.repeat(8192)}`, 'sb_secret_line\nbreak', 'not-a-secret-key']) {
    const result = await invoke({ body: PREPARE, env: { ...ENV, SUPABASE_SECRET_KEY: secret } });
    assert.equal(result.statusCode, 503);
    assert.equal(result.calls.length, 2);
    assert.ok(result.calls.every(call => call.headers.apikey === ENV.SUPABASE_PUBLISHABLE_KEY));
    assert.ok(!result.raw.includes(secret));
  }
});

test('a stalled media stream has a separate deadline and cannot finalize a version', async () => {
  let cancelled = false;
  let fallback;
  const result = await invoke({ body: COMMIT, streamTimeoutMs: 5,
    transport: commitTransport({ fileOverride: ({ bytes, mimeType }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes.subarray(0, 3)));
        // A short fallback prevents a broken implementation from hanging the suite.
        fallback = setTimeout(() => controller.close(), 250);
      },
      cancel() { cancelled = true; clearTimeout(fallback); },
    }), { headers: { 'Content-Type': mimeType, 'Content-Length': String(bytes.length) } }) }),
  });
  clearTimeout(fallback);
  assert.equal(result.statusCode, 504);
  assert.equal(cancelled, true, 'timed out media reads release the response stream');
  assert.ok(!result.calls.some(call => rpcName(call) === 'operator_commit_upload'));
});
