import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MAX_VIDEO_BYTES, validateVideoFile, hashVideoFile, validateSignedUploadUrl, putSignedVideo, readTerms, createVideoUploadJob, memberAccessState, assetReviewState, assetAttention } from '../operator.js';

const ORIGIN = 'https://operator-project.supabase.co';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const SESSION_TWO = '44444444-4444-4444-8444-444444444444';
const FIXED_NOW = 1800000000000;
const file = (name = 'delivery.webm', contents = 'separate video bytes', type = 'video/webm') => new File([contents], name, { type });
const signed = (sessionId = SESSION, kind = 'delivery', ext = '.webm') => `${ORIGIN}/storage/v1/object/upload/sign/staycut-deliverables/staging/${sessionId}/${kind}${ext}?token=temporary`;
const reservation = (sessionId = SESSION) => ({ sessionId, versionId: VERSION, expiresAt: new Date(FIXED_NOW + 3600000).toISOString(), delivery: { url: signed(sessionId) }, preview: { url: signed(sessionId, 'preview') } });

function form(overrides = {}) {
  const result = new FormData();
  for (const [key, value] of Object.entries({ accessStartDate: '2026-10-16', accessEndDate: '2027-10-16', rightsStartDate: '2026-10-16', rightsEndDate: '2027-10-16', rightsStatus: 'pending', ...overrides })) {
    for (const item of Array.isArray(value) ? value : [value]) result.append(key, item);
  }
  return result;
}

function jobHarness({ failUpload = false, failCommit = false, prepareOverride, commitOverride } = {}) {
  const calls = [], uploads = [], progress = [], hashes = [];
  let prepareCount = 0, commitCount = 0;
  const client = {
    user: { id: ACTOR },
    async configure() { return { origin: ORIGIN }; },
    async request(path, options) {
      assert.equal(path, '/api/operator'); const input = JSON.parse(options.body); calls.push(input);
      if (input.action === 'prepareUpload') { prepareCount += 1; return prepareOverride?.(input) || reservation(prepareCount === 1 ? SESSION : SESSION_TWO); }
      if (input.action === 'commitUpload') {
        commitCount += 1;
        if (failCommit && commitCount === 1) throw new Error('commit connection lost');
        return commitOverride?.(input) || { status: 'committed', sessionId: input.sessionId, versionId: VERSION };
      }
      throw new Error('Unexpected action');
    },
  };
  const deliveryFile = file(), previewFile = file('preview.webm', 'different reduced video bytes');
  const job = createVideoUploadJob({ client, input: { tenantId: ACTOR, assetId: null, title: '실제 작업' }, deliveryFile, previewFile,
    clock: () => FIXED_NOW, inspect: async () => ({ duration: 25, width: 1080, height: 1920 }),
    hash: async input => { hashes.push(input.name); return hashVideoFile(input, webcrypto); },
    upload: async (url, input, onProgress, options) => {
      uploads.push({ url, name: input.name, signal: options.signal }); onProgress(40);
      if (failUpload && uploads.length === 2) throw new Error('preview transfer lost');
      onProgress(100);
    }, onProgress: event => progress.push(event),
  });
  return { job, client, calls, uploads, progress, hashes };
}

test('file validation rejects zero, undersized, oversized, mismatched MIME and unsupported files', () => {
  assert.deepEqual(validateVideoFile(file()), { bytes: 20, mimeType: 'video/webm' });
  assert.throws(() => validateVideoFile(file('empty.webm', '')), /선택/);
  assert.throws(() => validateVideoFile(file('short.webm', 'tiny')), /영상 데이터/);
  assert.throws(() => validateVideoFile({ size: MAX_VIDEO_BYTES + 1, name: 'big.webm', type: 'video/webm', arrayBuffer() {} }), /50 MiB/);
  assert.throws(() => validateVideoFile(file('wrong.mp4', 'some video bytes', 'video/webm')), /MP4 또는 WebM/);
  assert.throws(() => validateVideoFile(file('clip.mov', 'some video bytes', 'video/quicktime')), /MP4 또는 WebM/);
});

test('file hash is the actual SHA-256 of bytes and requires WebCrypto', async () => {
  assert.equal(await hashVideoFile(file('clip.webm', 'abc'), webcrypto), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await assert.rejects(hashVideoFile(file(), {}), /HTTPS/);
});

test('signed uploads are restricted to exact project, staging session, file role and extension', () => {
  const expected = { sessionId: SESSION, kind: 'delivery', mimeType: 'video/webm' };
  assert.equal(validateSignedUploadUrl(signed(), ORIGIN, expected), signed());
  for (const url of [signed().replace(ORIGIN, 'https://evil.example'), signed().replace('/staging/', '/approved/'), signed().replace(SESSION, SESSION_TWO), signed(SESSION, 'preview'), signed().replace('.webm', '.mp4'), signed() + '&upsert=true', signed().replace('?token=temporary', ''), signed().replace('https:', 'http:')]) {
    assert.throws(() => validateSignedUploadUrl(url, ORIGIN, expected), /업로드 주소/);
  }
});

test('terms require real calendar dates, explicit valid-rights confirmation and intentional paid status', () => {
  const pending = readTerms(form());
  assert.equal(pending.rightsStatus, 'pending'); assert.equal(pending.finalDeliveryPaid, false); assert.equal(pending.accessAllowed, false);
  assert.throws(() => readTerms(form({ rightsStartDate: '2026-02-31' })), /날짜/);
  assert.throws(() => readTerms(form({ accessEndDate: '2025-01-01' })), /종료일/);
  assert.throws(() => readTerms(form({ rightsStatus: 'valid', allowedChannels: ['instagram'], allowedPurposes: ['organic'] })), /확인 항목/);
  const confirmed = readTerms(form({ rightsStatus: 'valid', rightsConfirmed: 'on', allowedChannels: ['instagram'], allowedPurposes: ['organic'], finalDeliveryPaid: 'on', accessAllowed: 'on' }));
  assert.equal(confirmed.finalDeliveryPaid, true); assert.equal(confirmed.accessAllowed, true); assert.equal(confirmed.rightsConfirmed, undefined);
});

test('two files are hashed sequentially; only actual completed PUTs precede final commit', async () => {
  const { job, calls, uploads, hashes, progress } = jobHarness();
  const result = await job.run();
  assert.equal(result.status, 'committed'); assert.deepEqual(hashes, ['delivery.webm', 'preview.webm']);
  assert.equal(uploads.length, 2); assert.deepEqual(calls.map(call => call.action), ['prepareUpload', 'commitUpload']);
  assert.notEqual(calls[0].delivery.sha256, calls[0].preview.sha256);
  assert.equal(calls[0].delivery.bytes, 20); assert.equal(calls[0].preview.mimeType, 'video/webm');
  assert.equal(progress.at(-1).phase, 'done');
});

test('an identical original and preview are rejected before reserving or transferring', async () => {
  const client = { user: { id: ACTOR }, request() { throw new Error('Must not reserve'); } };
  const same = file();
  const job = createVideoUploadJob({ client, input: {}, deliveryFile: same, previewFile: same, hash: input => hashVideoFile(input, webcrypto), inspect: async () => ({}) });
  await assert.rejects(job.run(), /같은 파일/);
});

test('uncertain transfer failure does not commit, and retry uses a fresh reservation without rehashing', async () => {
  const { job, calls, uploads, hashes, progress } = jobHarness({ failUpload: true });
  await assert.rejects(job.run(), /transfer lost/);
  assert.equal(calls.filter(call => call.action === 'commitUpload').length, 0);
  assert.equal(progress.some(event => event.phase === 'done'), false);
  await job.run();
  assert.deepEqual(calls.map(call => call.action), ['prepareUpload', 'prepareUpload', 'commitUpload']);
  assert.equal(uploads.length, 4); assert(uploads[2].url.includes(SESSION_TWO)); assert.equal(hashes.length, 2);
});

test('a failed final verification is retried idempotently without transferring or overwriting files again', async () => {
  const { job, calls, uploads } = jobHarness({ failCommit: true });
  await assert.rejects(job.run(), /commit connection lost/);
  const result = await job.run();
  assert.equal(result.status, 'committed'); assert.equal(uploads.length, 2);
  assert.deepEqual(calls.map(call => call.action), ['prepareUpload', 'commitUpload', 'commitUpload']);
  assert.equal(calls[1].sessionId, calls[2].sessionId);
});

test('wrong or missing committed status never produces a done progress state', async () => {
  const { job, progress } = jobHarness({ commitOverride: () => ({ status: 'prepared', sessionId: SESSION, versionId: VERSION }) });
  await assert.rejects(job.run(), /등록 완료 응답/);
  assert.equal(progress.some(event => event.phase === 'done'), false);
});

test('session change or cancellation prevents a pending operator job from committing', async () => {
  const h = jobHarness(); h.client.user = { id: VERSION };
  await assert.rejects(h.job.run(), /로그인 계정/); assert.equal(h.calls.length, 0);
  const canceled = jobHarness(); canceled.job.cancel();
  await assert.rejects(canceled.job.run(), /중단/); assert.equal(canceled.calls.length, 0);
});

test('raw file PUT shows actual progress, caps transfer at 99 until HTTP success, and never sends auth secrets', async () => {
  const headers = {}, progress = [];
  const fake = { upload: {}, open(method, url) { assert.equal(method, 'PUT'); assert.equal(url, signed()); }, setRequestHeader(key, value) { headers[key] = value; }, send(input) {
    assert.equal(input.name, 'delivery.webm');
    this.upload.onprogress({ lengthComputable: true, loaded: 20, total: 20 });
    assert.equal(progress.at(-1), 99);
    this.status = 200; this.onload(); this.onloadend();
  } };
  await putSignedVideo(signed(), file(), percent => progress.push(percent), { xhrFactory: () => fake });
  assert.deepEqual(progress, [99, 100]); assert.deepEqual(headers, { 'Content-Type': 'video/webm', 'x-upsert': 'false' });
});

test('a failed HTTP upload is rejected even after every byte was sent', async () => {
  const progress = [];
  const fake = { upload: {}, open() {}, setRequestHeader() {}, send() { this.upload.onprogress({ lengthComputable: true, loaded: 20, total: 20 }); this.status = 500; this.onload(); } };
  await assert.rejects(putSignedVideo(signed(), file(), value => progress.push(value), { xhrFactory: () => fake }), /업로드를 완료/);
  assert.deepEqual(progress, [99]);
});

test('membership eligibility honors inclusive dates and distinguishes scheduled, expired and revoked access', () => {
  const member = { active: true, access_allowed: true, access_start_date: '2026-10-16', access_end_date: '2026-10-22' };
  assert.equal(memberAccessState(member, '2026-10-16'), 'active');
  assert.equal(memberAccessState(member, '2026-10-22'), 'active');
  assert.equal(memberAccessState(member, '2026-10-15'), 'scheduled');
  assert.equal(memberAccessState(member, '2026-10-23'), 'expired');
  assert.equal(memberAccessState({ ...member, active: false }, '2026-10-16'), 'inactive');
  assert.equal(memberAccessState({ ...member, access_allowed: false }, '2026-10-16'), 'blocked');
  assert.equal(memberAccessState({ ...member, access_end_date: '2026-02-31' }, '2026-10-16'), 'invalid');
});

test('dashboard preserves revision priority and flags approval conditions that still block delivery', () => {
  const member = { tenant_id: ACTOR, user_id: VERSION, active: true, access_allowed: true, access_start_date: '2026-01-01', access_end_date: '2026-12-31' };
  const asset = { tenant_id: ACTOR, assigned_approver_id: VERSION, access_allowed: true, access_start_date: '2026-01-01', access_end_date: '2026-12-31', rights_status: 'valid', rights_start_date: '2026-01-01', rights_end_date: '2026-12-31', allowed_channels: ['instagram'], allowed_purposes: ['organic'], final_delivery_paid: true, latest_version: { review_status: 'approved' } };
  assert.equal(assetReviewState(asset), 'approved');
  assert.equal(assetReviewState({ ...asset, open_revision: { id: SESSION } }), 'revision');
  assert.equal(assetReviewState({ ...asset, latest_version: { review_status: 'revision_requested' } }), 'pending');
  assert.equal(assetReviewState({ ...asset, latest_version: null }), 'preparing');
  assert.deepEqual(assetAttention(asset, [member], '2026-10-16'), []);
  assert.deepEqual(assetAttention({ ...asset, rights_status: 'pending', final_delivery_paid: false }, [member], '2026-10-16'), ['이용허락 확인 전', '수납 확인 전']);
  assert.deepEqual(assetAttention({ ...asset, rights_start_date: '2026-11-01' }, [member], '2026-10-16'), ['사용 기간 확인']);
  assert.deepEqual(assetAttention(asset, [{ ...member, access_end_date: '2026-10-15' }], '2026-10-16'), ['승인자 접근 확인']);
});
