const BUCKET = 'staycut-deliverables';
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MIME_EXTENSIONS = { 'video/mp4': '.mp4', 'video/webm': '.webm' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateVideoFile(file, label = '영상') {
  if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw new Error(`${label} 파일을 선택해 주세요.`);
  if (file.size < 12) throw new Error(`${label} 파일의 영상 데이터를 확인해 주세요.`);
  if (file.size > MAX_VIDEO_BYTES) throw new Error(`${label}은 50 MiB 이하로 준비해 주세요.`);
  const extension = MIME_EXTENSIONS[file.type];
  if (!extension || !String(file.name).toLowerCase().endsWith(extension)) throw new Error(`${label}은 MP4 또는 WebM 영상 파일이어야 합니다.`);
  return { bytes: file.size, mimeType: file.type };
}

export async function hashVideoFile(file, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error('파일 검증에는 HTTPS 연결이 필요합니다. 보안 연결에서 다시 시도해 주세요.');
  const digest = await cryptoImpl.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function inspectVideoFile(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const cleanup = () => { clearTimeout(timer); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('영상 정보를 읽지 못했습니다. 브라우저에서 재생 가능한 파일로 준비해 주세요.')); }, 15000);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const metadata = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      if (!metadata.width || !metadata.height || !Number.isFinite(metadata.duration) || metadata.duration <= 0) { cleanup(); reject(new Error('영상 크기와 길이를 확인할 수 없습니다. 파일을 다시 확인해 주세요.')); return; }
      cleanup(); resolve(metadata);
    };
    video.onerror = () => { cleanup(); reject(new Error('이 브라우저에서 영상을 읽을 수 없습니다. 재생 가능한 MP4 또는 WebM 파일로 준비해 주세요.')); };
    video.src = url;
  });
}

export function validateSignedUploadUrl(value, origin, expected) {
  let url;
  try {
    url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== new URL(origin).origin || url.username || url.password || url.hash
      || !url.pathname.startsWith(`/storage/v1/object/upload/sign/${BUCKET}/staging/`) || !url.searchParams.get('token')
      || [...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length !== 1
      || /[\\\x00-\x20]/.test(String(value))) throw new Error();
    if (expected && url.pathname !== `/storage/v1/object/upload/sign/${BUCKET}/staging/${expected.sessionId}/${expected.kind}${MIME_EXTENSIONS[expected.mimeType]}`) throw new Error();
  } catch { throw new Error('업로드 주소를 확인할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.'); }
  return url.href;
}

export function putSignedVideo(url, file, onProgress = () => {}, { xhrFactory = () => new XMLHttpRequest(), signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('파일 업로드가 중단되었습니다.')); return; }
    const xhr = xhrFactory();
    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener('abort', abort);
    xhr.open('PUT', url, true);
    xhr.timeout = 5 * 60 * 1000;
    xhr.setRequestHeader('Content-Type', file.type);
    // Signed paths are unique and are never overwritten on retries.
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = event => { if (event.lengthComputable && event.total > 0) onProgress(Math.min(99, Math.floor(event.loaded / event.total * 100))); };
    xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) { onProgress(100); resolve(); } else reject(new Error('파일 업로드를 완료하지 못했습니다. 입력과 파일을 유지했으니 다시 시도해 주세요.')); };
    xhr.onerror = () => reject(new Error('업로드 연결이 끊겼습니다. 입력과 파일을 유지했으니 다시 시도해 주세요.'));
    xhr.ontimeout = () => reject(new Error('업로드 시간이 초과되었습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.'));
    xhr.onabort = () => reject(new Error('파일 업로드가 중단되었습니다.'));
    xhr.send(file);
  });
}

export function readTerms(formData) {
  const terms = {
    accessAllowed: formData.get('accessAllowed') === 'on', accessStartDate: String(formData.get('accessStartDate') || ''), accessEndDate: String(formData.get('accessEndDate') || ''),
    rightsStatus: String(formData.get('rightsStatus') || 'pending'), rightsStartDate: String(formData.get('rightsStartDate') || ''), rightsEndDate: String(formData.get('rightsEndDate') || ''),
    allowedChannels: formData.getAll('allowedChannels').map(String), allowedPurposes: formData.getAll('allowedPurposes').map(String), finalDeliveryPaid: formData.get('finalDeliveryPaid') === 'on',
  };
  if (![terms.accessStartDate, terms.accessEndDate, terms.rightsStartDate, terms.rightsEndDate].every(validDate)) throw new Error('접근 기간과 사용 기간의 날짜를 모두 올바르게 입력해 주세요.');
  if (terms.accessStartDate > terms.accessEndDate || terms.rightsStartDate > terms.rightsEndDate) throw new Error('기간의 종료일은 시작일 이후여야 합니다.');
  if (!['pending', 'valid', 'expired'].includes(terms.rightsStatus)) throw new Error('이용허락 상태를 확인해 주세요.');
  if (terms.allowedChannels.some(value => !['instagram', 'youtube'].includes(value)) || terms.allowedPurposes.some(value => !['organic', 'advertising'].includes(value))) throw new Error('사용 채널과 목적을 확인해 주세요.');
  if (terms.rightsStatus === 'valid' && (!terms.allowedChannels.length || !terms.allowedPurposes.length || formData.get('rightsConfirmed') !== 'on')) throw new Error('확인된 이용허락의 채널·목적을 선택하고 확인 항목에 체크해 주세요.');
  return terms;
}

function rpc(client, action, input = {}) {
  return client.request('/api/operator', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...input }) });
}

/** A failed PUT starts a new reservation; a failed commit retries its existing reservation. */
export function createVideoUploadJob({ client, input, deliveryFile, previewFile, onProgress = () => {}, hash = hashVideoFile, inspect = inspectVideoFile, upload = putSignedVideo, clock = () => Date.now() }) {
  let hashes;
  let reservation;
  let bytesUploaded = false;
  let running = false;
  const actorId = client.user?.id;
  const controller = new AbortController();
  const checkIdentity = () => { if (controller.signal.aborted || (actorId && actorId !== client.user?.id)) throw new Error('로그인 계정이 변경되었거나 업로드가 중단되었습니다. 현재 계정으로 다시 시작해 주세요.'); };
  return {
    cancel() { controller.abort(); },
    async run() {
      if (running) throw new Error('이미 업로드하고 있습니다. 완료될 때까지 기다려 주세요.');
      running = true;
      try {
        checkIdentity();
        const delivery = validateVideoFile(deliveryFile, '게시용 원본'), preview = validateVideoFile(previewFile, '검토용 미리보기');
        if (!hashes) {
          onProgress({ phase: 'validate', label: '두 영상의 재생 정보를 확인하고 있습니다.', percent: 0 });
          await inspect(deliveryFile); checkIdentity(); await inspect(previewFile); checkIdentity();
          onProgress({ phase: 'hash-delivery', label: '게시용 원본의 파일 해시를 계산하고 있습니다.', percent: 0 });
          const deliveryHash = await hash(deliveryFile);
          checkIdentity();
          onProgress({ phase: 'hash-preview', label: '검토용 미리보기의 파일 해시를 계산하고 있습니다.', percent: 0 });
          const previewHash = await hash(previewFile);
          checkIdentity();
          if (deliveryHash === previewHash) throw new Error('원본과 미리보기가 같은 파일입니다. 별도로 제작한 검토용 영상을 선택해 주세요.');
          hashes = { delivery: { ...delivery, sha256: deliveryHash }, preview: { ...preview, sha256: previewHash } };
        }
        if (reservation && Date.parse(reservation.expiresAt) <= clock()) { reservation = null; bytesUploaded = false; }
        if (!reservation) {
          onProgress({ phase: 'prepare', label: '권한과 새 파일 경로를 확인하고 있습니다.', percent: 0 });
          reservation = await rpc(client, 'prepareUpload', { ...input, ...hashes });
          checkIdentity();
          if (!UUID.test(reservation?.sessionId || '') || !UUID.test(reservation?.versionId || '') || !Number.isFinite(Date.parse(reservation?.expiresAt)) || Date.parse(reservation.expiresAt) <= clock()) { reservation = null; throw new Error('업로드 준비 응답을 확인할 수 없습니다. 다시 시도해 주세요.'); }
        }
        if (!bytesUploaded) {
          const config = await client.configure();
          const deliveryUrl = validateSignedUploadUrl(reservation.delivery?.url, config.origin, { sessionId: reservation.sessionId, kind: 'delivery', mimeType: delivery.mimeType }), previewUrl = validateSignedUploadUrl(reservation.preview?.url, config.origin, { sessionId: reservation.sessionId, kind: 'preview', mimeType: preview.mimeType });
          try {
            onProgress({ phase: 'delivery', label: '게시용 원본을 업로드하고 있습니다.', percent: 0 });
            checkIdentity();
            await upload(deliveryUrl, deliveryFile, percent => onProgress({ phase: 'delivery', label: '게시용 원본을 업로드하고 있습니다.', percent }), { signal: controller.signal });
            checkIdentity();
            onProgress({ phase: 'preview', label: '검토용 미리보기를 업로드하고 있습니다.', percent: 0 });
            await upload(previewUrl, previewFile, percent => onProgress({ phase: 'preview', label: '검토용 미리보기를 업로드하고 있습니다.', percent }), { signal: controller.signal });
            checkIdentity();
            bytesUploaded = true;
          } catch (error) { reservation = null; bytesUploaded = false; throw error; }
        }
        onProgress({ phase: 'commit', label: '서버에서 두 파일을 검증하고 작업을 등록하고 있습니다.', percent: 0 });
        checkIdentity();
        const result = await rpc(client, 'commitUpload', { sessionId: reservation.sessionId });
        checkIdentity();
        if (result?.status !== 'committed' || result?.sessionId !== reservation.sessionId || result?.versionId !== reservation.versionId) throw new Error('등록 완료 응답을 확인할 수 없습니다. 다시 시도해 주세요.');
        onProgress({ phase: 'done', label: '두 파일의 검증과 작업 등록을 완료했습니다.', percent: 100 });
        return result;
      } finally { running = false; }
    },
  };
}

const emptyTerms = () => ({ accessAllowed: false, accessStartDate: today(), accessEndDate: '', rightsStatus: 'pending', rightsStartDate: today(), rightsEndDate: '', allowedChannels: ['instagram'], allowedPurposes: ['organic'], finalDeliveryPaid: false });
const assetTerms = asset => ({ accessAllowed: asset.access_allowed, accessStartDate: asset.access_start_date, accessEndDate: asset.access_end_date, rightsStatus: asset.rights_status, rightsStartDate: asset.rights_start_date, rightsEndDate: asset.rights_end_date, allowedChannels: asset.allowed_channels || [], allowedPurposes: asset.allowed_purposes || [], finalDeliveryPaid: asset.final_delivery_paid });

function termsFields(terms, prefix) {
  const checked = value => value ? 'checked' : '';
  return `<div class="operator-field-grid"><label class="field" for="${prefix}-access-start"><span>파일 접근 시작일</span><input id="${prefix}-access-start" name="accessStartDate" type="date" value="${esc(terms.accessStartDate)}" required></label><label class="field" for="${prefix}-access-end"><span>파일 접근 종료일</span><input id="${prefix}-access-end" name="accessEndDate" type="date" value="${esc(terms.accessEndDate)}" required></label><label class="field" for="${prefix}-rights-start"><span>콘텐츠 사용 시작일</span><input id="${prefix}-rights-start" name="rightsStartDate" type="date" value="${esc(terms.rightsStartDate)}" required></label><label class="field" for="${prefix}-rights-end"><span>콘텐츠 사용 종료일</span><input id="${prefix}-rights-end" name="rightsEndDate" type="date" value="${esc(terms.rightsEndDate)}" required></label></div><div class="operator-field-grid"><fieldset class="field operator-checks"><legend>허용 채널</legend><label><input type="checkbox" name="allowedChannels" value="instagram" ${checked(terms.allowedChannels.includes('instagram'))}> Instagram</label><label><input type="checkbox" name="allowedChannels" value="youtube" ${checked(terms.allowedChannels.includes('youtube'))}> YouTube</label></fieldset><fieldset class="field operator-checks"><legend>허용 목적</legend><label><input type="checkbox" name="allowedPurposes" value="organic" ${checked(terms.allowedPurposes.includes('organic'))}> 자체 SNS 일반 게시</label><label><input type="checkbox" name="allowedPurposes" value="advertising" ${checked(terms.allowedPurposes.includes('advertising'))}> 유료 광고</label></fieldset></div><label class="field" for="${prefix}-rights-status"><span>이용허락 상태</span><select id="${prefix}-rights-status" name="rightsStatus"><option value="pending" ${terms.rightsStatus === 'pending' ? 'selected' : ''}>확인 전</option><option value="valid" ${terms.rightsStatus === 'valid' ? 'selected' : ''}>확인됨</option><option value="expired" ${terms.rightsStatus === 'expired' ? 'selected' : ''}>만료</option></select></label><label class="check-field"><input type="checkbox" name="rightsConfirmed"><span>‘확인됨’으로 저장할 경우, 등록한 기간·채널·목적에 대한 이용허락을 확인했습니다.</span></label><label class="check-field"><input type="checkbox" name="accessAllowed" ${checked(terms.accessAllowed)}><span>등록한 기간 동안 고객에게 이 작업의 파일 접근을 허용합니다.</span></label><label class="check-field operator-payment"><input type="checkbox" name="finalDeliveryPaid" ${checked(terms.finalDeliveryPaid)}><span>최종 전달 대금의 <strong>수납을 확인했습니다.</strong> 확인 전에는 체크하지 마세요.</span></label>`;
}


/** Membership and file access are separate gates; all date bounds use Seoul days. */
export function memberAccessState(member, date = today()) {
  if (!member?.active) return 'inactive';
  if (!member.access_allowed) return 'blocked';
  if (!validDate(member.access_start_date) || !validDate(member.access_end_date) || member.access_start_date > member.access_end_date) return 'invalid';
  if (date < member.access_start_date) return 'scheduled';
  if (date > member.access_end_date) return 'expired';
  return 'active';
}
export function assetReviewState(asset) {
  if (asset?.open_revision) return 'revision';
  if (asset?.latest_version?.review_status === 'approved') return 'approved';
  return asset?.latest_version ? 'pending' : 'preparing';
}
export function assetAttention(asset, members = [], date = today()) {
  const reasons = [];
  if (!asset.access_allowed) reasons.push('작업 접근 제한');
  else if (!validDate(asset.access_start_date) || !validDate(asset.access_end_date) || asset.access_start_date > date || asset.access_end_date < date) reasons.push('작업 접근 기간 확인');
  const approver = members.find(member => member.user_id === asset.assigned_approver_id && member.tenant_id === asset.tenant_id);
  if (!approver || memberAccessState(approver, date) !== 'active') reasons.push('승인자 접근 확인');
  if (asset.rights_status === 'expired' || (asset.rights_status === 'valid' && validDate(asset.rights_end_date) && asset.rights_end_date < date)) reasons.push('사용 기간 만료');
  else if (asset.rights_status === 'valid' && (!validDate(asset.rights_start_date) || !validDate(asset.rights_end_date) || asset.rights_start_date > date || asset.rights_start_date > asset.rights_end_date)) reasons.push('사용 기간 확인');
  if (assetReviewState(asset) === 'approved') {
    if (asset.rights_status === 'pending') reasons.push('이용허락 확인 전');
    if (asset.rights_status === 'valid' && (!asset.allowed_channels?.length || !asset.allowed_purposes?.length)) reasons.push('사용 범위 확인');
    if (!asset.final_delivery_paid) reasons.push('수납 확인 전');
  }
  return reasons;
}

const MEMBER_STATUS = { active: '현재 접근 가능', inactive: '배정 비활성', blocked: '접근 차단', scheduled: '접근 시작 전', expired: '접근 기간 만료', invalid: '접근 기간 확인' };
const REVIEW_STATUS = { revision: '수정 요청', approved: '내용 승인', pending: '고객 검토 대기', preparing: '첫 버전 준비' };

export function mountOperatorPortal({ root, client, showCustomer, showDemo, beforeOpen } = {}) {
  let active = false, busy = false, phase = 'idle', context, tenantId = '', job;
  let problem = '', message = '', requestSequence = 0, section = 'overview', uploadStep = 0, uploadStale = false;
  let contextUserId, observedUserId = client.user?.id, jobFilter = 'all', jobSearch = '', uploadAssetSnapshot = null;
  const nav = document.querySelector('#app-nav'), caption = document.querySelector('.header-caption'), entry = document.querySelector('#account-entry'), footer = document.querySelector('.site-footer p:last-child');
  const $ = selector => root.querySelector(selector);
  const tenantAssets = () => context?.assets?.filter(asset => asset.tenant_id === tenantId) || [];
  const tenantMembers = () => context?.members?.filter(member => member.tenant_id === tenantId) || [];
  const managementReady = () => Boolean(context?.members?.length && context.members.every(member => Number.isInteger(member.revision) && member.revision > 0));
  const eligibleMembers = () => tenantMembers().filter(member => memberAccessState(member) === 'active');
  const memberLabel = member => member?.email || member?.customer_email || member?.display_name || `고객 ${String(member?.user_id || '').slice(0, 8)}`;
  const assignedLabel = asset => memberLabel(tenantMembers().find(member => member.user_id === asset.assigned_approver_id));
  const statusMarkup = () => `<p class="operator-message" role="status" ${message ? '' : 'hidden'}>${esc(message)}</p><p class="operator-error form-error" role="alert" ${problem ? '' : 'hidden'}>${esc(problem)}</p>`;
  const disabledManagement = () => managementReady() ? '' : 'disabled';
  const upgradeNotice = () => managementReady() ? '' : '<p class="notice operator-upgrade" role="status">고객 배정·승인자 관리에는 추가 데이터베이스 구성이 필요합니다. 기존 영상 전달과 작업 조건 관리는 계속 사용할 수 있습니다.</p>';
  function chrome() {
    root.hidden = !active;
    if (!active) return;
    nav.hidden = true; caption.textContent = '운영자 작업 공간'; entry.textContent = client.user ? '내 작업' : '로그인';
    footer.textContent = '운영자가 등록한 실제 고객 작업입니다. 고객의 내용 승인과 실제 게시는 별도입니다.';
  }
  function heading() {
    return `<div class="page-heading"><div><p class="eyebrow">STUDIO WORKSPACE</p><h1>오늘의 제작을,<br>다음 단계로.</h1><p class="muted">숙소별 검토 현황을 확인하고 고객과 영상을 연결합니다.</p></div><div class="operator-toolbar"><button class="btn btn-secondary" type="button" data-operator="refresh" ${busy ? 'disabled' : ''}>새로고침</button><button class="text-link" type="button" data-operator="customer">고객 작업으로</button></div></div>`;
  }
  function tenantForm() {
    return `<details class="operator-panel operator-tenant-create" ${context?.tenants?.length ? '' : 'open'}><summary>새 숙소·고객사 등록</summary><p class="muted">계정 확인을 마친 기존 고객 이메일을 배정합니다. 고객 계정은 Supabase Authentication에서 먼저 만들고 확인해 주세요.</p><form id="operator-tenant-form"><div class="operator-field-grid"><label class="field" for="operator-tenant-name"><span>고객사·숙소 이름</span><input id="operator-tenant-name" name="name" maxlength="120" required></label><label class="field" for="operator-customer-email"><span>기존 고객 계정 이메일</span><input id="operator-customer-email" name="customerEmail" type="email" autocomplete="off" maxlength="254" required></label><label class="field" for="operator-member-start"><span>고객 접근 시작일</span><input id="operator-member-start" name="accessStartDate" type="date" value="${today()}" required></label><label class="field" for="operator-member-end"><span>고객 접근 종료일</span><input id="operator-member-end" name="accessEndDate" type="date" required></label></div><button class="btn btn-primary" type="submit">고객사 등록·계정 배정</button></form></details>`;
  }
  function dashboard() {
    const assets = tenantAssets();
    const counts = [
      ['pending', '고객 검토 대기', assets.filter(asset => assetReviewState(asset) === 'pending').length],
      ['revision', '미해결 수정 요청', assets.filter(asset => assetReviewState(asset) === 'revision').length],
      ['approved', '내용 승인 완료', assets.filter(asset => assetReviewState(asset) === 'approved').length],
      ['attention', '접근·조건 점검', assets.filter(asset => assetAttention(asset, tenantMembers()).length).length],
    ];
    return `<section id="operator-panel-overview" class="operator-tab-panel" role="tabpanel" aria-labelledby="operator-tab-overview"><div class="operator-section-intro"><div><p class="eyebrow">A CLEAR VIEW OF TODAY</p><h2>숙소의 작업 현황</h2><p class="muted">내용 승인 후에도 수납과 사용 조건에 따라 원본 다운로드가 제한될 수 있습니다.</p></div><button class="btn btn-primary" type="button" data-operator="new-delivery">새 영상 전달</button></div><div class="operator-stat-grid">${counts.map(([key, label, value]) => `<button class="operator-stat" data-operator="filter" data-filter="${key}" type="button" aria-pressed="${jobFilter === key}"><span>${label}</span><strong>${value}<small>건</small></strong><span class="operator-stat-link">작업 보기 ↗</span></button>`).join('')}</div><section class="operator-panel operator-jobs" aria-labelledby="operator-jobs-heading"><div class="operator-list-heading"><h3 id="operator-jobs-heading">전체 작업 <span>${assets.length}</span></h3><div class="operator-job-controls"><label class="field" for="operator-search"><span class="sr-only">작업 검색</span><input id="operator-search" type="search" placeholder="제목·승인자 검색" value="${esc(jobSearch)}"></label><label class="field" for="operator-filter"><span class="sr-only">작업 상태</span><select id="operator-filter"><option value="all">모든 상태</option><option value="pending">고객 검토 대기</option><option value="revision">수정 요청</option><option value="approved">내용 승인</option><option value="attention">접근·조건 점검</option></select></label></div></div><div id="operator-job-list">${jobCards()}</div></section></section>`;
  }
  function jobCards() {
    const search = jobSearch.trim().toLocaleLowerCase('ko');
    const assets = tenantAssets().filter(asset => {
      const state = assetReviewState(asset), attention = assetAttention(asset, tenantMembers());
      return (!search || `${asset.title} ${assignedLabel(asset)}`.toLocaleLowerCase('ko').includes(search))
        && (jobFilter === 'all' || (jobFilter === 'attention' ? attention.length > 0 : state === jobFilter));
    });
    if (!assets.length) return '<div class="operator-empty"><p>조건에 맞는 작업이 없습니다.</p><p class="muted">검색 조건을 바꾸거나 새 영상을 전달해 주세요.</p></div>';
    return assets.map(asset => {
      const state = assetReviewState(asset), attention = assetAttention(asset, tenantMembers());
      return `<article class="operator-job-card"><div class="operator-job-main"><div class="operator-job-topline"><span class="operator-badge operator-badge-${state}">${REVIEW_STATUS[state]}</span><span class="operator-version">${asset.latest_version ? `v${esc(asset.latest_version.version_number)}` : '버전 없음'}</span></div><h4>${esc(asset.title)}</h4><p class="operator-job-meta">승인자 ${esc(assignedLabel(asset))} · 접근 ${esc(asset.access_start_date)} ~ ${esc(asset.access_end_date)}</p>${asset.open_revision ? `<p class="operator-job-revision">${esc(asset.open_revision.message)}</p>` : ''}${attention.length ? `<p class="operator-job-attention">${attention.map(esc).join(' · ')}</p>` : ''}</div><div class="operator-job-actions"><button class="btn btn-secondary" type="button" data-operator="deliver" data-asset-id="${esc(asset.id)}">${state === 'revision' ? '수정본 전달' : '새 버전 전달'}</button><button class="text-link" type="button" data-operator="edit-job" data-asset-id="${esc(asset.id)}">조건·승인자 관리</button></div></article>`;
    }).join('');
  }
  function uploadForm() {
    const members = eligibleMembers(), assets = tenantAssets();
    return `<section id="operator-panel-delivery" class="operator-tab-panel" role="tabpanel" aria-labelledby="operator-tab-delivery" hidden><section class="operator-panel" aria-labelledby="operator-upload-heading"><p class="eyebrow">DELIVER A NEW STORY</p><h2 id="operator-upload-heading">영상 전달하기</h2><p class="muted">게시용 원본과 별도 검토용 영상을 단계별로 준비합니다. 각각 50 MiB 이하의 MP4·WebM을 지원합니다.</p><form id="operator-upload-form" novalidate><ol class="operator-steps" aria-label="영상 전달 단계"><li><button type="button" data-operator="upload-step" data-step="0" aria-current="step"><span>01</span>작업 선택</button></li><li><button type="button" data-operator="upload-step" data-step="1"><span>02</span>영상 준비</button></li><li><button type="button" data-operator="upload-step" data-step="2"><span>03</span>조건·최종 확인</button></li></ol><div class="operator-upload-stage" data-upload-stage="0"><h3 tabindex="-1">어떤 작업을 전달하나요?</h3><label class="field" for="operator-target"><span>전달할 작업</span><select id="operator-target" name="assetId"><option value="">새 작업 만들기</option>${assets.map(asset => `<option value="${esc(asset.id)}">${esc(asset.title)} · 새 버전 전달</option>`).join('')}</select></label><div id="operator-new-job"><div class="operator-field-grid"><label class="field" for="operator-title"><span>작업 제목</span><input id="operator-title" name="title" maxlength="200" required></label><label class="field" for="operator-approver"><span>지정 승인자</span><select id="operator-approver" name="assignedApproverId" required><option value="">승인자를 선택해 주세요</option>${members.map(member => `<option value="${esc(member.user_id)}">${esc(memberLabel(member))}</option>`).join('')}</select></label></div><p class="operator-field-hint">${members.length ? '현재 접근 가능한 배정 계정입니다. 저장 시 계정 확인 상태를 다시 검사합니다.' : '현재 접근 가능한 배정 계정이 없습니다. 고객 관리에서 배정·접근 기간을 확인해 주세요.'}</p></div><div id="operator-existing-job" class="notice" hidden></div><label class="field" for="operator-change-summary"><span>이번 버전 안내</span><textarea id="operator-change-summary" name="changeSummary" rows="3" maxlength="2000" placeholder="예: 요청하신 객실명과 마지막 안내 문구를 수정했어요."></textarea></label></div><div class="operator-upload-stage" data-upload-stage="1" hidden><h3 tabindex="-1">두 영상을 준비해 주세요.</h3><div class="operator-file-grid"><label class="field operator-file" for="operator-delivery"><span>게시용 원본</span><input id="operator-delivery" name="deliveryFile" type="file" accept="video/mp4,video/webm,.mp4,.webm" required><small>내용 승인·수납·사용 조건 확인 후 다운로드할 파일입니다.</small></label><label class="field operator-file" for="operator-preview"><span>별도 검토용 미리보기</span><input id="operator-preview" name="previewFile" type="file" accept="video/mp4,video/webm,.mp4,.webm" required><small>원본을 그대로 다시 선택할 수 없습니다.</small></label></div><label class="check-field"><input id="operator-preview-confirm" name="previewConfirmed" type="checkbox" required><span>게시용 원본과 구분되는 <strong>저용량 또는 워터마크 검토용 영상</strong>을 별도로 제작해 선택했습니다. 자동 변환은 제공하지 않습니다.</span></label><p class="operator-upload-note muted">파일은 비공개로 전달합니다. 두 파일의 실제 바이트와 해시를 서버에서 확인한 뒤에만 작업을 등록합니다.</p></div><div class="operator-upload-stage" data-upload-stage="2" hidden><h3 tabindex="-1">전달 조건을 확인해 주세요.</h3><div id="operator-upload-review" class="operator-review-summary"></div><div id="operator-new-terms"><details class="operator-contract" open><summary>접근·이용허락·수납 조건</summary>${termsFields(emptyTerms(), 'operator-new')}</details></div><div id="operator-existing-terms" class="notice" hidden></div></div><div class="operator-progress" hidden><p class="operator-progress-label" role="status"></p><progress max="100" value="0" aria-label="현재 파일 업로드 진행률"></progress><p class="operator-progress-hint muted">업로드 중에는 이 화면을 유지해 주세요.</p></div><p id="operator-upload-stale" class="notice" hidden>작업의 최신 상태를 다시 확인해야 합니다. 입력과 파일을 유지했습니다. <button class="text-link" type="button" data-operator="reload-upload">최신 작업 상태 확인</button></p><div class="operator-wizard-actions"><button class="btn btn-secondary" type="button" data-operator="upload-back" hidden>이전 단계</button><button class="btn btn-primary" type="button" data-operator="upload-next">영상 준비로</button><button class="btn btn-primary" type="submit" id="operator-upload-submit" hidden>두 파일 업로드·작업 등록</button></div></form></section></section>`;
  }
  function memberFields(member, prefix) {
    return `<div class="operator-field-grid"><label class="field" for="${prefix}-start"><span>고객 접근 시작일</span><input id="${prefix}-start" name="accessStartDate" type="date" value="${esc(member.access_start_date)}" required></label><label class="field" for="${prefix}-end"><span>고객 접근 종료일</span><input id="${prefix}-end" name="accessEndDate" type="date" value="${esc(member.access_end_date)}" required></label></div><label class="check-field"><input type="checkbox" name="accessAllowed" ${member.access_allowed ? 'checked' : ''}><span>위 기간 동안 이 숙소의 고객 접근을 허용합니다.</span></label>`;
  }
  function memberManagement() {
    const members = tenantMembers();
    return `<section id="operator-panel-members" class="operator-tab-panel" role="tabpanel" aria-labelledby="operator-tab-members" hidden><div class="operator-section-intro"><div><p class="eyebrow">THE RIGHT PEOPLE, THE RIGHT ACCESS</p><h2>고객 관리</h2><p class="muted">고객의 숙소 배정과 접근 기간을 관리합니다. 각 작업의 파일 접근 기간도 함께 충족해야 파일을 볼 수 있습니다.</p></div></div>${upgradeNotice()}<div class="operator-management-grid"><section class="operator-panel"><h3>기존 고객 계정 추가</h3><p class="muted">계정 확인을 마친 이메일만 추가할 수 있습니다. 계정 생성이나 초대 메일 발송은 포함하지 않습니다.</p><form id="operator-member-add-form"><label class="field" for="operator-member-email"><span>기존 고객 계정 이메일</span><input id="operator-member-email" name="customerEmail" type="email" maxlength="254" autocomplete="off" required></label>${memberFields({ access_start_date: today(), access_end_date: '', access_allowed: false }, 'operator-add-member')}<button class="btn btn-primary" type="submit" ${disabledManagement()}>이 숙소에 고객 배정</button></form></section><section class="operator-panel operator-members-panel"><div class="operator-list-heading"><h3>배정된 고객 <span>${members.length}</span></h3></div><div class="operator-member-list">${members.map((member, index) => {
      const assigned = tenantAssets().filter(asset => asset.assigned_approver_id === member.user_id).length;
      return `<details class="operator-member" data-member-id="${esc(member.user_id)}"><summary><span><strong>${esc(memberLabel(member))}</strong><small>${esc(member.access_start_date)} ~ ${esc(member.access_end_date)}</small></span><span class="operator-badge operator-badge-${memberAccessState(member) === 'active' ? 'approved' : 'attention'}">${MEMBER_STATUS[memberAccessState(member)]}</span></summary><form class="operator-member-edit-form" data-user-id="${esc(member.user_id)}" data-revision="${esc(member.revision)}"><p class="operator-field-hint">지정 승인 작업 ${assigned}건 · ${member.role === 'owner' ? '고객사 소유자' : '고객사 멤버'}. 이 배정은 제작 운영자 권한을 부여하지 않습니다.</p>${memberFields(member, `operator-member-${index}`)}<label class="check-field"><input type="checkbox" name="active" ${member.active ? 'checked' : ''}><span>이 숙소의 고객 배정을 활성화합니다.</span></label><div class="operator-member-actions"><button class="btn btn-secondary" type="submit" ${disabledManagement()}>접근 조건 저장</button><button class="text-link operator-revoke-link" type="button" data-operator="confirm-revoke" ${!member.active && !member.access_allowed ? 'disabled' : disabledManagement()}>이 숙소 접근 회수</button></div><div class="operator-revoke-confirm" hidden><p>고객 계정을 삭제하지 않고 이 숙소의 배정과 접근을 비활성화합니다. 기존 승인 이력은 보존됩니다.${assigned ? ` 지정 승인 작업 ${assigned}건의 승인자를 작업 조건에서 확인해 주세요.` : ''} 이미 발급된 파일 링크는 최대 60초 동안 유효할 수 있습니다.</p><label class="check-field"><input type="checkbox" name="revokeConfirmed"><span>이 숙소의 고객 접근을 회수하겠습니다.</span></label><button class="btn btn-secondary" type="button" data-operator="revoke-member" ${disabledManagement()}>접근 회수 확인</button><button class="text-link" type="button" data-operator="cancel-revoke">취소</button></div><div class="operator-form-feedback" aria-live="polite"></div></form></details>`;
    }).join('') || '<p class="muted">배정된 고객 계정이 없습니다.</p>'}</div></section></div>${tenantForm()}</section>`;
  }
  function termsForm() {
    const assets = tenantAssets();
    if (!assets.length) return '<section id="operator-panel-terms" class="operator-tab-panel" role="tabpanel" aria-labelledby="operator-tab-terms" hidden><div class="operator-empty"><h2>등록된 작업이 없습니다.</h2><p>영상을 전달한 뒤 작업의 조건과 승인자를 관리할 수 있습니다.</p><button class="btn btn-primary" type="button" data-operator="new-delivery">새 영상 전달</button></div></section>';
    return `<section id="operator-panel-terms" class="operator-tab-panel" role="tabpanel" aria-labelledby="operator-tab-terms" hidden><div class="operator-section-intro"><div><p class="eyebrow">KEEP THE DETAILS CLEAR</p><h2>작업 조건 관리</h2><p class="muted">파일을 다시 올리지 않고 조건과 지정 승인자를 변경합니다. 기존 내용 승인 이력은 보존됩니다.</p></div></div><label class="field operator-asset-select" for="operator-terms-asset"><span>관리할 작업</span><select id="operator-terms-asset">${assets.map(asset => `<option value="${esc(asset.id)}">${esc(asset.title)}</option>`).join('')}</select></label><div class="operator-management-grid"><section class="operator-panel"><h3>접근·이용허락·수납</h3><form id="operator-terms-form"><input type="hidden" name="assetId" value="${esc(assets[0].id)}"><div id="operator-terms-fields">${termsFields(assetTerms(assets[0]), 'operator-edit')}</div><button class="btn btn-primary" type="submit">작업 조건 저장</button></form></section><section class="operator-panel"><h3>지정 승인자 변경</h3><p class="muted">현재 접근 가능한 고객사 멤버에게 다음 검토를 배정합니다. 과거 승인자의 승인 기록은 그대로 남습니다.</p>${upgradeNotice()}<div id="operator-approver-fields">${approverForm(assets[0])}</div></section></div></section>`;
  }
  function approverForm(asset) {
    return `<form id="operator-approver-form" data-asset-id="${esc(asset.id)}" data-expected-assigned="${esc(asset.assigned_approver_id || '')}" data-expected-version="${esc(asset.latest_version_id || '')}"><p class="operator-assignment-current">현재 승인자 <strong>${esc(assignedLabel(asset))}</strong></p><label class="field" for="operator-new-approver"><span>변경할 승인자</span><select id="operator-new-approver" name="assignedApproverId" required><option value="">승인자를 선택해 주세요</option>${eligibleMembers().map(member => `<option value="${esc(member.user_id)}" ${member.user_id === asset.assigned_approver_id ? 'selected' : ''}>${esc(memberLabel(member))}</option>`).join('')}</select></label><p class="operator-field-hint">접근 기간이 유효한 계정만 표시합니다. 저장 시 계정 확인 상태와 최신 작업 상태를 다시 검사합니다.</p><button class="btn btn-secondary" type="submit" ${disabledManagement()}>지정 승인자 저장</button><div class="operator-form-feedback" aria-live="polite"></div></form>`;
  }
  function render() {
    if (!active) return;
    chrome();
    if (busy && phase === 'ready' && root.children.length) return;
    if (!client.user && phase !== 'loading') { root.innerHTML = `<div class="page-container operator-console">${heading()}<div class="empty-state"><h2>운영자 계정으로 로그인해 주세요.</h2><p>로그인 후 이 화면에서 운영자 권한을 확인합니다.</p><button class="btn btn-primary" type="button" data-operator="customer">로그인 화면으로</button></div></div>`; return; }
    if (phase === 'loading') { root.innerHTML = `<div class="page-container operator-console">${heading()}<div class="empty-state" role="status"><p>운영자 권한과 고객 작업을 확인하고 있습니다…</p></div></div>`; return; }
    if (phase === 'denied' || phase === 'error') { root.innerHTML = `<div class="page-container operator-console">${heading()}${statusMarkup()}<div class="empty-state"><h2>${phase === 'denied' ? '운영자 권한이 필요한 공간입니다.' : '작업 공간을 불러오지 못했어요.'}</h2><p>${phase === 'denied' ? '고객사 소유자 권한과 제작 운영자 권한은 별도로 관리됩니다.' : '위 안내를 확인하고 다시 시도해 주세요.'}</p><button class="btn btn-secondary" type="button" data-operator="customer">고객 작업으로 돌아가기</button></div></div>`; return; }
    root.innerHTML = `<div class="page-container operator-console">${heading()}${statusMarkup()}${context?.tenants?.length ? `<section class="operator-customer-select"><label class="field" for="operator-tenant"><span>작업할 고객사·숙소</span><select id="operator-tenant">${context.tenants.map(tenant => `<option value="${esc(tenant.id)}" ${tenant.id === tenantId ? 'selected' : ''}>${esc(tenant.name)}</option>`).join('')}</select></label><div class="operator-tenant-summary"><strong>${tenantAssets().length}</strong>개 작업 <span>·</span> <strong>${tenantMembers().filter(member => memberAccessState(member) === 'active').length}</strong>명 현재 접근 가능<button class="text-link" type="button" data-operator="members">고객 관리 ↗</button></div></section><div class="operator-tabs" role="tablist" aria-label="운영자 관리 메뉴">${[['overview', '작업 현황'], ['delivery', '영상 전달'], ['members', '고객 관리'], ['terms', '작업 조건']].map(([key, label]) => `<button id="operator-tab-${key}" type="button" role="tab" data-operator="section" data-section="${key}" aria-controls="operator-panel-${key}" aria-selected="${section === key}" tabindex="${section === key ? 0 : -1}">${label}</button>`).join('')}</div>${dashboard()}${uploadForm()}${memberManagement()}${termsForm()}` : `${tenantForm()}<div class="empty-state"><h2>첫 고객사를 등록해 주세요.</h2><p>확인된 고객 계정을 배정한 뒤 작업과 영상을 전달할 수 있습니다.</p></div>`}</div>`;
    uploadStep = 0; uploadStale = false; uploadAssetSnapshot = null;
    showSection(section); updateDashboard(); setUploadStep(0);
  }
  function showSection(next) {
    section = ['overview', 'delivery', 'members', 'terms'].includes(next) ? next : 'overview';
    root.querySelectorAll('.operator-tab-panel').forEach(panel => { panel.hidden = panel.id !== `operator-panel-${section}`; });
    root.querySelectorAll('[role="tab"]').forEach(tab => { const selected = tab.dataset.section === section; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
  }
  function updateDashboard() {
    const list = $('#operator-job-list'); if (list) list.innerHTML = jobCards();
    if ($('#operator-filter')) $('#operator-filter').value = jobFilter;
    root.querySelectorAll('.operator-stat').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === jobFilter)));
  }
  function displayStatus() {
    const error = $('.operator-error'), notice = $('.operator-message');
    if (error) { error.textContent = problem; error.hidden = !problem; }
    if (notice) { notice.textContent = message; notice.hidden = !message; }
  }
  function fail(error) {
    problem = error?.message || '요청을 처리하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.';
    message = ''; displayStatus(); $('.operator-error')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function setBusy(value) {
    busy = value; root.setAttribute('aria-busy', String(value));
    root.querySelectorAll('input,select,textarea,button').forEach(element => {
      if (value) { element.dataset.operatorWasDisabled = String(Boolean(element.disabled)); element.disabled = true; }
      else if (Object.hasOwn(element.dataset, 'operatorWasDisabled')) { element.disabled = element.dataset.operatorWasDisabled === 'true'; delete element.dataset.operatorWasDisabled; }
    });
    if (!value && uploadStale && $('#operator-upload-submit')) $('#operator-upload-submit').disabled = true;
  }
  async function getContext() {
    const actorId = client.user?.id;
    const data = await rpc(client, 'context');
    if (!actorId || actorId !== client.user?.id) throw new Error('로그인 계정이 변경되었습니다. 현재 계정으로 다시 열어 주세요.');
    if (!data?.operator?.user_id || ![data.tenants, data.members, data.assets].every(Array.isArray)) throw new Error('운영자 작업 목록을 확인할 수 없습니다. 다시 시도해 주세요.');
    context = data; contextUserId = actorId;
    if (!context.tenants.some(tenant => tenant.id === tenantId)) tenantId = context.tenants[0]?.id || '';
  }
  async function refresh() {
    const sequence = ++requestSequence; phase = 'loading'; busy = true; problem = ''; render();
    try {
      if (!client.user) await client.restore();
      if (sequence !== requestSequence) return;
      if (!client.user) { phase = 'login'; return; }
      await getContext(); if (sequence === requestSequence) phase = 'ready';
    } catch (error) {
      if (sequence !== requestSequence) return;
      context = null; phase = error?.code === 'permission' ? 'denied' : 'error';
      problem = phase === 'denied' ? '현재 계정에는 제작 운영자 권한이 없습니다. 고객 작업 공간을 이용해 주세요.' : error?.message || '운영자 권한을 확인하지 못했습니다.';
    } finally { if (sequence === requestSequence) { busy = false; render(); } }
  }
  function open({ focus = true, updateHash = true } = {}) {
    if (contextUserId && contextUserId !== client.user?.id) invalidate();
    active = true; beforeOpen?.(); document.querySelectorAll('section[data-page]').forEach(element => { element.hidden = element !== root; });
    document.querySelectorAll('video').forEach(video => video.pause());
    if (updateHash && location.hash !== '#manage') history.replaceState(null, '', '#manage');
    document.title = '제작 운영 · STAYCUT'; chrome();
    if (!context || phase !== 'ready') refresh(); else render();
    if (focus) { const h1 = $('h1'); h1?.setAttribute('tabindex', '-1'); h1?.focus({ preventScroll: true }); }
  }
  function leave() { active = false; root.hidden = true; nav.hidden = false; caption.textContent = '가상 숙소 · 디자인 시안'; entry.textContent = client.user ? '내 작업' : '로그인'; }
  function invalidate() {
    ++requestSequence; job?.cancel(); context = null; contextUserId = undefined; tenantId = ''; job = null; phase = 'idle'; problem = ''; message = ''; busy = false; uploadStale = false; uploadAssetSnapshot = null; root.innerHTML = '';
  }
  function resetJob() {
    job = null; const button = $('#operator-upload-submit');
    if (button) button.textContent = '두 파일 업로드·작업 등록';
    $('.operator-progress')?.setAttribute('hidden', '');
  }
  function applyTarget() {
    const id = $('#operator-target')?.value || '', existing = Boolean(id), asset = tenantAssets().find(item => item.id === id);
    // Retain exactly the version/revision shown with this selection. Background
    // management refreshes must never acknowledge feedback the operator has not seen.
    uploadAssetSnapshot = asset || null;
    for (const selector of ['#operator-new-job', '#operator-new-terms']) {
      const box = $(selector); if (!box) continue;
      box.hidden = existing; box.querySelectorAll('input,select,textarea').forEach(input => { input.disabled = existing; });
    }
    const info = $('#operator-existing-job'); info.hidden = !existing;
    info.innerHTML = asset ? `<p><strong>${esc(asset.title)}</strong> · ${asset.latest_version ? `최신 v${esc(asset.latest_version.version_number)}` : '첫 버전 준비 중'}</p><p>현재 승인자 ${esc(assignedLabel(asset))}. 기존 사용 조건·수납 상태를 유지합니다.</p>${asset.open_revision ? `<p class="operator-feedback">${esc(asset.open_revision.message)}</p><label class="check-field"><input name="revisionReviewed" type="checkbox" required><span>위 수정 요청을 확인하고 새 버전에 반영했습니다. 등록 시 이 요청이 처리됩니다.</span></label>` : '<p>현재 미해결 수정 요청이 없습니다.</p>'}` : '';
    const existingTerms = $('#operator-existing-terms'); existingTerms.hidden = !existing;
    existingTerms.innerHTML = asset ? `<p>이 작업의 조건을 유지합니다. 변경은 작업 조건에서 별도로 저장해 주세요.</p><p>파일 접근 ${asset.access_allowed ? '허용' : '제한'} · ${esc(asset.access_start_date)} ~ ${esc(asset.access_end_date)}</p><p>이용허락 ${asset.rights_status === 'valid' ? '확인됨' : asset.rights_status === 'expired' ? '만료' : '확인 전'} · 수납 ${asset.final_delivery_paid ? '확인됨' : '확인 전'}</p>` : '';
    resetJob(); updateUploadReview();
  }
  function updateUploadReview() {
    const form = $('#operator-upload-form'); if (!form) return;
    const data = new FormData(form), asset = uploadAssetSnapshot?.id === data.get('assetId') ? uploadAssetSnapshot : null;
    const files = ['deliveryFile', 'previewFile'].map(name => data.get(name));
    $('#operator-upload-review').innerHTML = `<dl><div><dt>전달 작업</dt><dd>${esc(asset?.title || data.get('title') || '새 작업')}</dd></div><div><dt>지정 승인자</dt><dd>${esc(asset ? assignedLabel(asset) : memberLabel(tenantMembers().find(member => member.user_id === data.get('assignedApproverId'))))}</dd></div><div><dt>게시용 원본</dt><dd>${esc(files[0]?.name || '선택 전')}</dd></div><div><dt>검토용 영상</dt><dd>${esc(files[1]?.name || '선택 전')}</dd></div></dl>`;
  }
  function validUploadStep(step) {
    const box = $(`[data-upload-stage="${step}"]`); if (!box) return true;
    for (const field of box.querySelectorAll('input,select,textarea')) if (!field.disabled && !field.checkValidity()) { field.reportValidity(); return false; }
    if (step === 1) {
      validateVideoFile($('#operator-delivery').files[0], '게시용 원본'); validateVideoFile($('#operator-preview').files[0], '검토용 미리보기');
    }
    return true;
  }
  function setUploadStep(next, { validate = false, focus = false } = {}) {
    if (!$('#operator-upload-form')) return;
    next = Math.max(0, Math.min(2, next));
    if (validate && next > uploadStep) {
      for (let index = uploadStep; index < next; index += 1) if (!validUploadStep(index)) return;
    }
    uploadStep = next;
    root.querySelectorAll('[data-upload-stage]').forEach(box => { box.hidden = Number(box.dataset.uploadStage) !== next; });
    root.querySelectorAll('[data-operator="upload-step"]').forEach(button => {
      if (Number(button.dataset.step) === next) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    });
    $('[data-operator="upload-back"]').hidden = next === 0; $('[data-operator="upload-next"]').hidden = next === 2; $('#operator-upload-submit').hidden = next !== 2;
    $('[data-operator="upload-next"]').textContent = next === 0 ? '영상 준비로' : '조건·최종 확인으로';
    updateUploadReview();
    if (focus) $(`[data-upload-stage="${next}"] h3`)?.focus({ preventScroll: true });
  }
  function selectTermsAsset(id) {
    const asset = tenantAssets().find(item => item.id === id); if (!asset) return;
    $('#operator-terms-asset').value = id;
    $('#operator-terms-form [name="assetId"]').value = id;
    $('#operator-terms-fields').innerHTML = termsFields(assetTerms(asset), 'operator-edit');
    $('#operator-approver-fields').innerHTML = approverForm(asset);
  }
  function progress({ phase: stage, label, percent }) {
    const box = $('.operator-progress'); if (!box) return;
    box.hidden = false; $('.operator-progress-label').textContent = label;
    const bar = box.querySelector('progress');
    if (['delivery', 'preview', 'done'].includes(stage)) bar.value = percent; else bar.removeAttribute('value');
    $('.operator-progress-hint').textContent = stage === 'commit' ? '서버 검증이 끝날 때까지 기다려 주세요. 파일 전송 완료만으로 등록되지는 않습니다.' : stage === 'done' ? '고객에게는 배정·접근 기간에 따라 작업이 표시됩니다.' : '업로드 중에는 이 화면을 유지해 주세요.';
  }
  function memberInput(form, { revoke = false } = {}) {
    const data = new FormData(form);
    const input = {
      tenantId, userId: form.dataset.userId, expectedRevision: Number(form.dataset.revision),
      active: revoke ? false : data.get('active') === 'on', accessAllowed: revoke ? false : data.get('accessAllowed') === 'on',
      accessStartDate: String(data.get('accessStartDate') || ''), accessEndDate: String(data.get('accessEndDate') || ''),
    };
    if (!managementReady() || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('고객 관리 데이터베이스 구성을 먼저 완료해 주세요.');
    if (!validDate(input.accessStartDate) || !validDate(input.accessEndDate) || input.accessStartDate > input.accessEndDate) throw new Error('고객 접근 기간을 올바르게 입력해 주세요.');
    return input;
  }
  function conflictNotice(form) {
    const feedback = form.querySelector('.operator-form-feedback'); if (!feedback) return;
    feedback.innerHTML = '<div class="operator-conflict"><p>다른 곳에서 상태가 변경되었습니다. 입력은 유지했습니다. 최신 상태와 비교한 뒤 다시 저장해 주세요.</p><button class="text-link" type="button" data-operator="review-conflict">최신 상태 확인</button></div>';
  }
  async function reviewConflict(form) {
    const sequence = requestSequence, actorId = client.user?.id;
    setBusy(true);
    try {
      await getContext(); if (sequence !== requestSequence || actorId !== client.user?.id) return;
      const isMember = form.classList.contains('operator-member-edit-form');
      const latest = isMember ? tenantMembers().find(member => member.user_id === form.dataset.userId) : tenantAssets().find(asset => asset.id === form.dataset.assetId);
      if (!latest) throw new Error('현재 배정이나 작업을 찾지 못했습니다. 입력을 확인한 뒤 목록을 새로고침해 주세요.');
      const revision = isMember ? latest.revision : null;
      if (isMember && (!Number.isInteger(revision) || revision < 1)) throw new Error('고객 관리 데이터베이스 구성을 먼저 완료해 주세요.');
      form.dataset.reviewRevision = isMember ? String(revision) : '';
      form.dataset.reviewAssigned = isMember ? '' : latest.assigned_approver_id || '';
      form.dataset.reviewVersion = isMember ? '' : latest.latest_version_id || '';
      const summary = isMember ? `${MEMBER_STATUS[memberAccessState(latest)]} · ${latest.access_start_date} ~ ${latest.access_end_date} · 배정 ${latest.active ? '활성' : '비활성'} / 접근 ${latest.access_allowed ? '허용' : '차단'}` : `현재 승인자 ${assignedLabel(latest)} · ${latest.latest_version ? `v${latest.latest_version.version_number}` : '버전 없음'}`;
      form.querySelector('.operator-form-feedback').innerHTML = `<div class="operator-conflict"><p><strong>서버의 최신 상태</strong><br>${esc(summary)}</p><p>입력한 값은 위에 유지했습니다. 최신 상태를 덮어써도 되는지 확인해 주세요.</p><label class="check-field"><input type="checkbox" name="conflictReviewed"><span>최신 상태와 비교했고 현재 입력으로 저장하겠습니다.</span></label><div class="operator-inline-actions"><button class="btn btn-secondary" type="button" data-operator="apply-conflict">현재 입력으로 다시 저장</button><button class="text-link" type="button" data-operator="reload-conflict">입력을 최신 값으로 바꾸기</button></div></div>`;
    } catch (error) { if (sequence === requestSequence && actorId === client.user?.id) fail(error); }
    finally { if (sequence === requestSequence && actorId === client.user?.id) setBusy(false); }
  }
  async function saveMember(form, { revoke = false } = {}) {
    if (revoke && new FormData(form).get('revokeConfirmed') !== 'on') throw new Error('접근 회수 확인 항목에 체크해 주세요.');
    if (revoke) {
      form.elements.active.checked = false;
      form.elements.accessAllowed.checked = false;
    }
    const input = memberInput(form, { revoke }), sequence = requestSequence, actorId = client.user?.id;
    setBusy(true);
    try {
      await rpc(client, 'updateMember', input); if (sequence !== requestSequence || actorId !== client.user?.id) return;
      await getContext(); message = !input.active && !input.accessAllowed ? '이 숙소의 고객 배정과 접근을 회수했습니다. 기존 승인 이력은 보존됩니다.' : '고객 배정과 접근 기간을 저장했습니다.';
      problem = ''; busy = false; render();
    } catch (error) {
      if (sequence !== requestSequence || actorId !== client.user?.id) return;
      if (error?.code === 'STATE_CONFLICT') conflictNotice(form);
      fail(error);
    } finally { if (sequence === requestSequence && actorId === client.user?.id) setBusy(false); }
  }
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-operator]'); if (!button || button.disabled) return;
    const action = button.dataset.operator;
    if (action === 'customer') { showCustomer?.(); return; }
    if (action === 'demo') { showDemo?.(); return; }
    if (busy) return;
    try {
      if (action === 'refresh') { job?.cancel(); job = null; refresh(); return; }
      if (action === 'section') { showSection(button.dataset.section); return; }
      if (action === 'members') { showSection('members'); return; }
      if (action === 'filter') { jobFilter = button.dataset.filter; updateDashboard(); return; }
      if (action === 'deliver' || action === 'new-delivery') {
        showSection('delivery'); $('#operator-target').value = button.dataset.assetId || ''; applyTarget(); setUploadStep(0, { focus: true }); return;
      }
      if (action === 'edit-job') { showSection('terms'); selectTermsAsset(button.dataset.assetId); return; }
      if (action === 'upload-next') { setUploadStep(uploadStep + 1, { validate: true, focus: true }); return; }
      if (action === 'upload-back') { setUploadStep(uploadStep - 1, { focus: true }); return; }
      if (action === 'upload-step') { setUploadStep(Number(button.dataset.step), { validate: true, focus: true }); return; }
      if (action === 'confirm-revoke' || action === 'cancel-revoke') {
        const box = button.closest('form').querySelector('.operator-revoke-confirm'); box.hidden = action === 'cancel-revoke';
        box.querySelector('[name="revokeConfirmed"]').checked = false; return;
      }
      if (action === 'revoke-member') { await saveMember(button.closest('form'), { revoke: true }); return; }
      if (action === 'review-conflict') { await reviewConflict(button.closest('form')); return; }
      if (action === 'apply-conflict') {
        const form = button.closest('form');
        if (new FormData(form).get('conflictReviewed') !== 'on') throw new Error('최신 상태를 비교한 뒤 확인 항목에 체크해 주세요.');
        if (form.classList.contains('operator-member-edit-form')) form.dataset.revision = form.dataset.reviewRevision;
        else { form.dataset.expectedAssigned = form.dataset.reviewAssigned; form.dataset.expectedVersion = form.dataset.reviewVersion; }
        form.querySelector('.operator-form-feedback').innerHTML = ''; form.requestSubmit(); return;
      }
      if (action === 'reload-conflict') {
        const form = button.closest('form');
        if (form.classList.contains('operator-member-edit-form')) {
          const latest = tenantMembers().find(member => member.user_id === form.dataset.userId); if (!latest) return;
          form.dataset.revision = String(latest.revision); form.elements.active.checked = latest.active; form.elements.accessAllowed.checked = latest.access_allowed;
          form.elements.accessStartDate.value = latest.access_start_date; form.elements.accessEndDate.value = latest.access_end_date;
          form.querySelector('.operator-form-feedback').innerHTML = ''; form.querySelector('.operator-revoke-confirm').hidden = true;
        } else selectTermsAsset(form.dataset.assetId);
        problem = ''; displayStatus(); return;
      }
      if (action === 'reload-upload') {
        const sequence = requestSequence, actorId = client.user?.id, selected = $('#operator-target').value;
        setBusy(true);
        try {
          await getContext(); if (sequence !== requestSequence || actorId !== client.user?.id) return;
          if (selected && !tenantAssets().some(asset => asset.id === selected)) throw new Error('전달할 작업을 찾지 못했습니다. 입력을 확인한 뒤 목록을 새로고침해 주세요.');
          setBusy(false); applyTarget(); uploadStale = false; $('#operator-upload-submit').disabled = false; $('#operator-upload-stale').hidden = true;
          setUploadStep(0, { focus: true }); message = '입력과 파일을 유지하고 최신 작업 상태를 불러왔습니다. 승인자와 수정 요청을 다시 확인해 주세요.'; problem = ''; displayStatus();
        } finally { if (sequence === requestSequence && actorId === client.user?.id) setBusy(false); }
      }
    } catch (error) { fail(error); }
  });
  root.addEventListener('keydown', event => {
    const tab = event.target.closest('[role="tab"]'); if (!tab || busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...root.querySelectorAll('[role="tab"]')], index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    showSection(tabs[next].dataset.section); tabs[next].focus();
  });
  root.addEventListener('change', event => {
    if (busy) return;
    if (event.target.id === 'operator-tenant') { tenantId = event.target.value; job?.cancel(); job = null; message = ''; problem = ''; jobSearch = ''; jobFilter = 'all'; render(); return; }
    if (event.target.id === 'operator-filter') { jobFilter = event.target.value; updateDashboard(); return; }
    if (event.target.id === 'operator-target') applyTarget();
    if (event.target.id === 'operator-terms-asset') selectTermsAsset(event.target.value);
    if (event.target.closest('#operator-upload-form')) { resetJob(); updateUploadReview(); }
  });
  root.addEventListener('input', event => {
    if (busy) return;
    if (event.target.id === 'operator-search') { jobSearch = event.target.value; updateDashboard(); return; }
    if (event.target.closest('#operator-upload-form')) resetJob();
  });
  root.addEventListener('submit', async event => {
    const form = event.target;
    if (!['operator-tenant-form', 'operator-upload-form', 'operator-terms-form', 'operator-member-add-form', 'operator-approver-form'].includes(form.id) && !form.classList.contains('operator-member-edit-form')) return;
    event.preventDefault(); if (busy) return;
    if (form.id === 'operator-upload-form' && uploadStep < 2) {
      try { setUploadStep(uploadStep + 1, { validate: true, focus: true }); } catch (error) { fail(error); }
      return;
    }
    if (form.id === 'operator-upload-form') {
      if (uploadStale) { fail(new Error('최신 작업 상태를 확인한 뒤 전달을 다시 준비해 주세요.')); return; }
      for (let step = 0; step < 3; step += 1) {
        setUploadStep(step);
        try { if (!validUploadStep(step)) return; } catch (error) { fail(error); return; }
      }
    } else if (!form.checkValidity()) { form.reportValidity(); return; }
    problem = ''; message = ''; displayStatus();
    if (form.classList.contains('operator-member-edit-form')) { try { await saveMember(form); } catch (error) { fail(error); } return; }
    const data = new FormData(form), sequence = requestSequence, actorId = client.user?.id;
    const current = () => sequence === requestSequence && actorId === client.user?.id;
    try {
      if (form.id === 'operator-tenant-form') {
        const input = { name: String(data.get('name') || '').trim(), customerEmail: String(data.get('customerEmail') || '').trim(), accessStartDate: String(data.get('accessStartDate') || ''), accessEndDate: String(data.get('accessEndDate') || '') };
        if (!input.name || !validDate(input.accessStartDate) || !validDate(input.accessEndDate) || input.accessStartDate > input.accessEndDate) throw new Error('고객사 이름과 접근 기간을 확인해 주세요.');
        setBusy(true); const result = await rpc(client, 'createTenant', input); if (!current()) return;
        await getContext(); tenantId = result?.tenantId || result?.tenant?.id || context.tenants.find(tenant => tenant.name === input.name)?.id || tenantId;
        message = '고객사를 등록하고 확인된 계정을 배정했습니다.'; section = 'overview'; phase = 'ready'; busy = false; render(); return;
      }
      if (form.id === 'operator-member-add-form') {
        if (!managementReady()) throw new Error('고객 관리 데이터베이스 구성을 먼저 완료해 주세요.');
        const input = { tenantId, customerEmail: String(data.get('customerEmail') || '').trim(), accessAllowed: data.get('accessAllowed') === 'on', accessStartDate: String(data.get('accessStartDate') || ''), accessEndDate: String(data.get('accessEndDate') || '') };
        if (!input.customerEmail || !validDate(input.accessStartDate) || !validDate(input.accessEndDate) || input.accessStartDate > input.accessEndDate) throw new Error('고객 계정과 접근 기간을 확인해 주세요.');
        setBusy(true); await rpc(client, 'addMember', input); if (!current()) return; await getContext();
        message = '확인된 고객 계정을 이 숙소에 배정했습니다.'; busy = false; render(); return;
      }
      if (form.id === 'operator-approver-form') {
        if (!managementReady()) throw new Error('고객 관리 데이터베이스 구성을 먼저 완료해 주세요.');
        const input = { assetId: form.dataset.assetId, assignedApproverId: String(data.get('assignedApproverId') || ''), expectedAssignedApproverId: form.dataset.expectedAssigned || null, expectedLatestVersionId: form.dataset.expectedVersion || null };
        if (!UUID.test(input.assignedApproverId)) throw new Error('변경할 승인자를 선택해 주세요.');
        setBusy(true); await rpc(client, 'assignApprover', input); if (!current()) return; await getContext();
        message = '지정 승인자를 변경했습니다. 기존 승인 이력은 보존됩니다.'; busy = false; render(); return;
      }
      if (form.id === 'operator-terms-form') {
        const input = { assetId: String(data.get('assetId') || ''), terms: readTerms(data) };
        setBusy(true); await rpc(client, 'updateAsset', input); if (!current()) return; await getContext();
        message = '작업의 접근·이용허락·수납 조건을 저장했습니다.'; phase = 'ready'; busy = false; render(); return;
      }
      const existingId = String(data.get('assetId') || '');
      const input = { tenantId, assetId: existingId || null, changeSummary: String(data.get('changeSummary') || '').trim() };
      if (existingId) {
        const asset = uploadAssetSnapshot;
        if (!asset || asset.id !== existingId) throw new Error('현재 고객사의 작업을 다시 선택해 주세요.');
        if (asset.open_revision && data.get('revisionReviewed') !== 'on') throw new Error('기존 수정 요청을 확인하고 반영 여부에 체크해 주세요.');
        input.expectedRevisionId = asset.open_revision?.id || null; input.expectedLatestVersionId = asset.latest_version_id || null;
      } else {
        input.title = String(data.get('title') || '').trim(); input.assignedApproverId = String(data.get('assignedApproverId') || ''); input.terms = readTerms(data);
        if (!input.title || !UUID.test(input.assignedApproverId)) throw new Error('작업 제목과 지정 승인자를 확인해 주세요.');
      }
      if (data.get('previewConfirmed') !== 'on') throw new Error('별도로 제작한 검토용 영상의 확인 항목에 체크해 주세요.');
      if (!job) job = createVideoUploadJob({ client, input, deliveryFile: data.get('deliveryFile'), previewFile: data.get('previewFile'), onProgress: progress });
      setBusy(true); await job.run(); if (!current()) return; job = null;
      message = '두 영상의 실제 파일 검증을 마치고 새 버전을 등록했습니다.';
      try { await getContext(); phase = 'ready'; busy = false; section = 'overview'; render(); }
      catch { message = '영상과 작업은 등록되었습니다. 최신 목록은 새로고침해서 확인해 주세요.'; problem = ''; displayStatus(); }
    } catch (error) {
      if (!current()) return;
      if (error?.code === 'STATE_CONFLICT' && form.id === 'operator-approver-form') conflictNotice(form);
      if (form.id === 'operator-upload-form' && ['UPLOAD_CONFLICT', 'STATE_CONFLICT', 'state'].includes(error?.code)) {
        uploadStale = true; $('#operator-upload-stale').hidden = false;
        error.message = '작업의 최신 상태가 변경되었습니다. 입력과 파일을 유지했으니 최신 승인자·버전·수정 요청을 확인한 뒤 다시 준비해 주세요.';
      }
      fail(error);
      const button = $('#operator-upload-submit'); if (job && button) button.textContent = '업로드·등록 다시 시도';
      const hint = $('.operator-progress-hint'); if (hint && job) hint.textContent = uploadStale ? '최신 작업 상태를 확인해야 합니다. 같은 등록 요청을 반복하지 않습니다.' : '입력과 파일을 유지했습니다. 전송 실패는 새 경로에 다시 업로드하고, 최종 등록 실패는 서버 검증을 다시 요청합니다.';
    } finally { if (current()) setBusy(false); }
  });
  client.subscribe?.(user => {
    const nextId = user?.id; if (nextId === observedUserId) return;
    observedUserId = nextId;
    if (nextId && phase === 'loading' && !context && !job) return;
    invalidate(); if (active) { if (user) refresh(); else render(); }
  });
  return { open, leave, invalidate };
}
