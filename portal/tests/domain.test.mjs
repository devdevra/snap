import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalBlockReason,
  canApprove,
  canDownload,
  createInitialState,
  downloadBlockReason,
  fixtures,
  validDate,
  validOptionalUrl,
} from '../domain.js';

// These inputs describe an order's contract, independently of the demo UI data.
const TODAY = '2026-10-15';
const ACTOR = 'assigned-owner';
const VERSION = 'room-film-v2';

function pendingAsset(overrides = {}) {
  return {
    id: 'room-film',
    versionId: VERSION,
    version: 2,
    approvalStatus: 'pending',
    approverId: ACTOR,
    isLatest: true,
    previewAvailable: true,
    accessAllowed: true,
    accessStartDate: '2026-10-01',
    accessExpireDate: '2026-10-31',
    rightsStatus: 'valid',
    rightsStartDate: '2026-10-01',
    rightsExpireDate: '2026-10-31',
    channels: ['instagram'],
    purposes: ['organic'],
    finalDeliveryPaid: true,
    source: 'assets/room-film-v2.mp4',
    publicationResponses: [],
    downloads: [],
    ...overrides,
  };
}

function approvedAsset(overrides = {}) {
  return pendingAsset({
    approvalStatus: 'approved',
    approval: { versionId: VERSION, actor: ACTOR, at: '2026-10-14T12:00:00Z' },
    ...overrides,
  });
}

function approvalOptions(overrides = {}) {
  return {
    actorId: ACTOR,
    versionId: VERSION,
    confirmed: true,
    date: TODAY,
    channel: 'instagram',
    purpose: 'organic',
    ...overrides,
  };
}

function downloadOptions(overrides = {}) {
  return { date: TODAY, versionId: VERSION, channel: 'instagram', purpose: 'organic', ...overrides };
}

function expectApprovalBlocked(asset, options = approvalOptions()) {
  assert.equal(canApprove(asset, options), false);
  assert.ok(approvalBlockReason(asset, options).trim(), 'blocked approval explains the next action');
}

function expectDownloadBlocked(asset, options = downloadOptions()) {
  assert.equal(canDownload(asset, options), false);
  assert.ok(downloadBlockReason(asset, options).trim(), 'blocked delivery explains the next action');
}

test('the assigned approver can approve a checked, current, usable version', () => {
  const asset = pendingAsset();
  assert.equal(canApprove(asset, approvalOptions()), true);
  assert.equal(approvalBlockReason(asset, approvalOptions()), '');
});

test('review confirmation is explicit; a missing or unchecked confirmation never approves', () => {
  expectApprovalBlocked(pendingAsset(), approvalOptions({ confirmed: false }));
  const { confirmed, ...withoutConfirmation } = approvalOptions();
  expectApprovalBlocked(pendingAsset(), withoutConfirmation);
});

test('a failed preview or an unsent revision draft blocks approval', () => {
  expectApprovalBlocked(pendingAsset({ previewAvailable: false }));
  expectApprovalBlocked(pendingAsset(), approvalOptions({ feedback: '객실 이름을 수정해 주세요.' }));
  assert.equal(canApprove(pendingAsset(), approvalOptions({ feedback: ' \n\t ' })), true);
});

test('approval must target the latest exact version and the assigned person', () => {
  expectApprovalBlocked(pendingAsset({ isLatest: false }));
  expectApprovalBlocked(pendingAsset(), approvalOptions({ versionId: 'room-film-v1' }));
  expectApprovalBlocked(pendingAsset(), approvalOptions({ actorId: 'another-owner' }));
});

test('a revision request cannot become approval of that same version', () => {
  expectApprovalBlocked(pendingAsset({ approvalStatus: 'revision_requested' }));
  expectApprovalBlocked(pendingAsset({ approvalStatus: 'producing' }));
  expectApprovalBlocked(approvedAsset());
});

test('a late review remains pending and still requires an explicit confirmation', () => {
  const overdue = pendingAsset({ dueDate: '2026-10-14' });
  expectApprovalBlocked(overdue, approvalOptions({ confirmed: false }));
  assert.equal(canApprove(overdue, approvalOptions()), true);
  assert.equal(overdue.approvalStatus, 'pending');
  assert.equal(overdue.approval, undefined);
});

test('missing versions cannot be approved or delivered', () => {
  expectApprovalBlocked(undefined);
  expectDownloadBlocked(undefined);
});

test('unverified or explicitly expired rights block both final approval and delivery', () => {
  for (const rightsStatus of ['unconfirmed', 'pending', 'expired']) {
    expectApprovalBlocked(pendingAsset({ rightsStatus }));
    expectDownloadBlocked(approvedAsset({ rightsStatus }));
  }
});

test('permission for one channel or purpose does not grant another', () => {
  expectApprovalBlocked(pendingAsset(), approvalOptions({ channel: 'youtube' }));
  expectDownloadBlocked(approvedAsset(), downloadOptions({ channel: 'youtube' }));
  expectApprovalBlocked(pendingAsset(), approvalOptions({ purpose: 'advertising' }));
  expectDownloadBlocked(approvedAsset(), downloadOptions({ purpose: 'advertising' }));
});

test('every requested channel and purpose needs an explicit grant', () => {
  expectApprovalBlocked(pendingAsset({ channels: [] }));
  expectDownloadBlocked(approvedAsset({ channels: undefined }));
  expectApprovalBlocked(pendingAsset({ purposes: [] }));
  expectDownloadBlocked(approvedAsset({ purposes: undefined }));
  const grants = { channels: ['instagram', 'youtube'], purposes: ['organic', 'advertising'] };
  assert.equal(canApprove(pendingAsset(grants), approvalOptions({ channel: 'youtube', purpose: 'advertising' })), true);
  assert.equal(canDownload(approvedAsset(grants), downloadOptions({ channel: 'youtube', purpose: 'advertising' })), true);
});

test('rights dates include the contracted first and last day only', () => {
  for (const date of ['2026-10-01', '2026-10-31']) {
    assert.equal(canApprove(pendingAsset(), approvalOptions({ date })), true);
    assert.equal(canDownload(approvedAsset(), downloadOptions({ date })), true);
  }
  const widerAccess = { accessStartDate: '2026-09-01', accessExpireDate: '2026-11-30' };
  for (const date of ['2026-09-30', '2026-11-01']) {
    expectApprovalBlocked(pendingAsset(widerAccess), approvalOptions({ date }));
    expectDownloadBlocked(approvedAsset(widerAccess), downloadOptions({ date }));
  }
});

test('missing, impossible, or reversed rights periods never grant approval or delivery', () => {
  for (const period of [
    { rightsStartDate: undefined },
    { rightsExpireDate: undefined },
    { rightsStartDate: '2026-02-30' },
    { rightsExpireDate: '2026-10-32' },
    { rightsStartDate: '2026-10-31', rightsExpireDate: '2026-10-01' },
  ]) {
    expectApprovalBlocked(pendingAsset(period));
    expectDownloadBlocked(approvedAsset(period));
  }
});

test('an invalid evaluation date fails closed instead of granting access', () => {
  for (const date of ['', '2026-02-29', '2026-10-15T00:00:00Z']) {
    expectApprovalBlocked(pendingAsset(), approvalOptions({ date }));
    expectDownloadBlocked(approvedAsset(), downloadOptions({ date }));
  }
});

test('access is required independently of a still-valid usage license', () => {
  expectApprovalBlocked(pendingAsset({ accessAllowed: false }));
  expectDownloadBlocked(approvedAsset({ accessAllowed: false }));
  for (const period of [
    { accessStartDate: '2026-10-16' },
    { accessExpireDate: '2026-10-14' },
    { accessStartDate: 'invalid' },
    { accessExpireDate: undefined },
    { accessStartDate: '2026-10-31', accessExpireDate: '2026-10-01' },
  ]) {
    expectApprovalBlocked(pendingAsset(period));
    expectDownloadBlocked(approvedAsset(period));
  }
});

test('file-access first and last days are usable when rights cover those days', () => {
  const wideRights = { rightsStartDate: '2026-09-01', rightsExpireDate: '2026-11-30' };
  for (const date of ['2026-10-01', '2026-10-31']) {
    assert.equal(canApprove(pendingAsset(wideRights), approvalOptions({ date })), true);
    assert.equal(canDownload(approvedAsset(wideRights), downloadOptions({ date })), true);
  }
  for (const date of ['2026-09-30', '2026-11-01']) {
    expectApprovalBlocked(pendingAsset(wideRights), approvalOptions({ date }));
    expectDownloadBlocked(approvedAsset(wideRights), downloadOptions({ date }));
  }
});

test('an available source is not deliverable before exact-version approval', () => {
  expectDownloadBlocked(pendingAsset());
  expectDownloadBlocked(pendingAsset({ approvalStatus: 'revision_requested' }));
  expectDownloadBlocked(approvedAsset({ approval: undefined }));
  expectDownloadBlocked(approvedAsset({ approval: { versionId: 'room-film-v1', actor: ACTOR } }));
});

test('old files and stale requests remain blocked even with an approval record', () => {
  expectDownloadBlocked(approvedAsset({ isLatest: false }));
  expectDownloadBlocked(approvedAsset(), downloadOptions({ versionId: 'room-film-v1' }));
});

test('a valid approval permits delivery only after final payment is confirmed', () => {
  for (const finalDeliveryPaid of [false, undefined, null, 'true']) {
    const asset = approvedAsset({ finalDeliveryPaid });
    const approval = structuredClone(asset.approval);
    expectDownloadBlocked(asset);
    assert.deepEqual(asset.approval, approval, 'payment hold preserves the approval record');
  }
  assert.equal(canDownload(approvedAsset({ finalDeliveryPaid: true }), downloadOptions()), true);
});

test('payment may remain outstanding while the content itself is reviewed and approved', () => {
  assert.equal(canApprove(pendingAsset({ finalDeliveryPaid: false }), approvalOptions()), true);
});

test('a contracted file still needs an actual delivery source', () => {
  expectDownloadBlocked(approvedAsset({ source: '' }));
  expectDownloadBlocked(approvedAsset({ source: undefined }));
});

test('normal exact-version approval allows download without another review confirmation', () => {
  const asset = pendingAsset();
  assert.equal(canApprove(asset, approvalOptions()), true);
  const approved = {
    ...asset,
    approvalStatus: 'approved',
    approval: { versionId: VERSION, actor: ACTOR, at: '2026-10-15T10:00:00Z' },
  };
  assert.equal(canDownload(approved, downloadOptions()), true);
  assert.equal(downloadBlockReason(approved, downloadOptions()), '');
});

test('a later license expiry, access expiry, or replacement never erases past approval', () => {
  for (const change of [
    { rightsExpireDate: '2026-10-14' },
    { rightsStatus: 'pending' },
    { accessExpireDate: '2026-10-14' },
    { isLatest: false },
  ]) {
    const asset = approvedAsset(change);
    const before = structuredClone(asset);
    expectDownloadBlocked(asset);
    assert.deepEqual(asset, before);
    assert.equal(asset.approval.versionId, VERSION);
  }
});

test('approval, download requests, and customer publication reports remain separate facts', () => {
  const approvedUnpublished = approvedAsset({
    downloads: [{ versionId: VERSION, at: '2026-10-15T09:00:00Z' }],
    publicationResponses: [],
  });
  const before = structuredClone(approvedUnpublished);
  assert.equal(canDownload(approvedUnpublished, downloadOptions()), true);
  assert.deepEqual(approvedUnpublished, before, 'eligibility checks do not create a publication report');
  assert.deepEqual(approvedUnpublished.publicationResponses, []);

  const reportedButUnapproved = pendingAsset({
    publicationResponses: [{ versionId: VERSION, channel: 'instagram', status: 'published', date: TODAY }],
  });
  expectDownloadBlocked(reportedButUnapproved);
  assert.equal(reportedButUnapproved.approval, undefined);
});

test('demo approved fixtures do not invent a publication event or transfer approval to a new version', () => {
  const state = createInitialState();
  const approved = state.assets.filter(asset => asset.approvalStatus === 'approved');
  const pending = state.assets.filter(asset => asset.approvalStatus === 'pending');
  assert.ok(approved.length > 0);
  assert.ok(pending.length > 0);
  for (const asset of approved) {
    assert.equal(asset.approval.versionId, asset.versionId);
    assert.deepEqual(asset.publicationResponses, []);
  }
  for (const asset of pending) assert.equal(asset.approval, undefined);

  approved[0].publicationResponses.push({ versionId: approved[0].versionId, channel: 'instagram', status: 'published', date: TODAY });
  assert.deepEqual(createInitialState().assets.find(asset => asset.id === approved[0].id).publicationResponses, []);
  assert.deepEqual(fixtures.find(asset => asset.id === approved[0].id).publicationResponses, []);
  for (const asset of state.assets.filter(asset => asset.id !== approved[0].id)) assert.deepEqual(asset.publicationResponses, []);
});

test('contract date validation rejects rollover dates and accepts real leap days', () => {
  for (const value of ['2024-02-29', '2026-10-15']) assert.equal(validDate(value), true);
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', '', undefined]) {
    assert.equal(validDate(value), false, `${String(value)} is not a contract date`);
  }
});

test('a publication URL is optional, and only ordinary web links are accepted', () => {
  for (const value of ['', '   ', 'https://www.instagram.com/p/example/', ' http://example.com/post ']) {
    assert.equal(validOptionalUrl(value), true);
  }
  for (const value of ['not a url', 'javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/post']) {
    assert.equal(validOptionalUrl(value), false);
  }
});
