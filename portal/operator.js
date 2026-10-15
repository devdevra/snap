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

export function mountOperatorPortal({ root, client, showCustomer, showDemo, beforeOpen } = {}) {
  let active = false, busy = false, phase = 'idle', context, tenantId = '', job;
  let problem = '', message = '', requestSequence = 0;
  let contextUserId, observedUserId = client.user?.id;
  const nav = document.querySelector('#app-nav'), caption = document.querySelector('.header-caption'), entry = document.querySelector('#account-entry'), footer = document.querySelector('.site-footer p:last-child');
  const $ = selector => root.querySelector(selector);
  const tenantAssets = () => context?.assets?.filter(asset => asset.tenant_id === tenantId) || [];
  const tenantMembers = () => context?.members?.filter(member => member.tenant_id === tenantId) || [];
  const statusMarkup = () => `<p class="operator-message" role="status" ${message ? '' : 'hidden'}>${esc(message)}</p><p class="operator-error form-error" role="alert" ${problem ? '' : 'hidden'}>${esc(problem)}</p>`;
  const memberLabel = member => member.email || member.customer_email || member.display_name || `고객 ${String(member.user_id || '').slice(0, 8)}`;
  function chrome() {
    root.hidden = !active;
    if (!active) return;
    nav.hidden = true; caption.textContent = '운영자 작업 공간'; entry.textContent = client.user ? '내 작업' : '로그인';
    footer.textContent = '운영자가 등록한 실제 고객 작업입니다. 고객의 내용 승인과 실제 게시는 별도입니다.';
  }
  function heading() { return `<div class="page-heading"><div><p class="eyebrow">STUDIO WORKSPACE</p><h1>제작을 전달하고,<br>검토를 시작해요.</h1><p class="muted">고객사 배정부터 영상 전달까지 한곳에서 준비합니다.</p></div><div class="operator-toolbar"><button class="btn btn-secondary" type="button" data-operator="refresh" ${busy ? 'disabled' : ''}>새로고침</button><button class="text-link" type="button" data-operator="customer">고객 작업으로</button></div></div>`; }
  function tenantForm() { return `<details class="operator-panel operator-tenant-create" ${context?.tenants?.length ? '' : 'open'}><summary>새 고객사 등록</summary><p class="muted">이미 계정 확인을 마친 고객의 이메일을 입력하세요. 계정을 새로 만들거나 초대 메일을 보내는 기능은 포함하지 않습니다.</p><form id="operator-tenant-form"><div class="operator-field-grid"><label class="field" for="operator-tenant-name"><span>고객사·숙소 이름</span><input id="operator-tenant-name" name="name" maxlength="120" required></label><label class="field" for="operator-customer-email"><span>고객 계정 이메일</span><input id="operator-customer-email" name="customerEmail" type="email" autocomplete="off" maxlength="254" required></label><label class="field" for="operator-member-start"><span>고객 접근 시작일</span><input id="operator-member-start" name="accessStartDate" type="date" value="${today()}" required></label><label class="field" for="operator-member-end"><span>고객 접근 종료일</span><input id="operator-member-end" name="accessEndDate" type="date" required></label></div><button class="btn btn-primary" type="submit">고객사 등록·계정 배정</button></form></details>`; }
  function uploadForm() {
    const members = tenantMembers().filter(member => member.active && member.access_allowed), assets = tenantAssets();
    return `<section class="operator-panel" aria-labelledby="operator-upload-heading"><p class="eyebrow">DELIVER A NEW STORY</p><h2 id="operator-upload-heading">영상 전달하기</h2><p class="muted">게시용 원본과 별도의 검토용 영상을 함께 준비해 주세요. 각각 50 MiB 이하의 MP4·WebM을 지원합니다.</p><form id="operator-upload-form"><label class="field" for="operator-target"><span>전달할 작업</span><select id="operator-target" name="assetId"><option value="">새 작업 만들기</option>${assets.map(asset => `<option value="${esc(asset.id)}">${esc(asset.title)} · 새 버전 전달</option>`).join('')}</select></label><div id="operator-new-job"><div class="operator-field-grid"><label class="field" for="operator-title"><span>작업 제목</span><input id="operator-title" name="title" maxlength="200" required></label><label class="field" for="operator-approver"><span>지정 승인자</span><select id="operator-approver" name="assignedApproverId" required><option value="">승인자를 선택해 주세요</option>${members.map(member => `<option value="${esc(member.user_id)}">${esc(memberLabel(member))}</option>`).join('')}</select></label></div>${members.length ? '' : '<p class="notice">접근이 허용된 고객사 멤버가 없습니다. 고객사 배정과 접근 기간을 확인해 주세요.</p>'}<details class="operator-contract" open><summary>접근·이용허락·수납 조건</summary>${termsFields(emptyTerms(), 'operator-new')}</details></div><div id="operator-existing-job" class="notice" hidden>새 버전은 기존 작업의 승인자·사용 조건·수납 상태를 유지합니다. 조건 변경은 아래 작업 조건 관리에서 저장하세요. 기존 수정 요청은 새 버전 등록 시 처리됩니다.</div><label class="field" for="operator-change-summary"><span>이번 버전 안내</span><textarea id="operator-change-summary" name="changeSummary" rows="3" maxlength="2000" placeholder="예: 요청하신 객실명과 마지막 안내 문구를 수정했어요."></textarea></label><div class="operator-file-grid"><label class="field operator-file" for="operator-delivery"><span>게시용 원본</span><input id="operator-delivery" name="deliveryFile" type="file" accept="video/mp4,video/webm,.mp4,.webm" required><small>내용 승인·수납·사용 조건 확인 후 다운로드할 파일입니다.</small></label><label class="field operator-file" for="operator-preview"><span>별도 검토용 미리보기</span><input id="operator-preview" name="previewFile" type="file" accept="video/mp4,video/webm,.mp4,.webm" required><small>원본을 그대로 다시 선택할 수 없습니다.</small></label></div><label class="check-field"><input id="operator-preview-confirm" name="previewConfirmed" type="checkbox" required><span>게시용 원본과 구분되는 <strong>저용량 또는 워터마크 검토용 영상</strong>을 별도로 제작해 선택했습니다. 이 화면은 영상을 자동 변환하지 않습니다.</span></label><p class="operator-upload-note muted">파일은 비공개로 업로드합니다. 두 파일의 실제 바이트와 해시를 서버에서 확인한 뒤에만 작업을 등록합니다.</p><div class="operator-progress" hidden><p class="operator-progress-label" role="status"></p><progress max="100" value="0" aria-label="현재 파일 업로드 진행률"></progress><p class="operator-progress-hint muted">업로드 중에는 이 화면을 유지해 주세요.</p></div><button class="btn btn-primary" type="submit" id="operator-upload-submit">두 파일 업로드·작업 등록</button></form></section>`;
  }
  function termsForm() {
    const assets = tenantAssets(); if (!assets.length) return '';
    return `<section class="operator-panel" aria-labelledby="operator-terms-heading"><p class="eyebrow">KEEP THE DETAILS CLEAR</p><h2 id="operator-terms-heading">작업 조건 관리</h2><p class="muted">파일을 다시 올리지 않고 접근·이용허락·수납 조건을 변경합니다. 기존 내용 승인 이력은 보존됩니다.</p><form id="operator-terms-form"><label class="field" for="operator-terms-asset"><span>조건을 변경할 작업</span><select id="operator-terms-asset" name="assetId">${assets.map(asset => `<option value="${esc(asset.id)}">${esc(asset.title)}</option>`).join('')}</select></label><div id="operator-terms-fields">${termsFields(assetTerms(assets[0]), 'operator-edit')}</div><button class="btn btn-primary" type="submit">작업 조건 저장</button></form></section>`;
  }
  function render() {
    if (!active) return;
    chrome();
    if (busy && phase === 'ready' && root.children.length) return;
    if (!client.user && phase !== 'loading') { root.innerHTML = `<div class="page-container operator-console">${heading()}<div class="empty-state"><h2>운영자 계정으로 로그인해 주세요.</h2><p>로그인 후 이 화면에서 운영자 권한을 확인합니다.</p><button class="btn btn-primary" type="button" data-operator="customer">로그인 화면으로</button></div></div>`; return; }
    if (phase === 'loading') { root.innerHTML = `<div class="page-container operator-console">${heading()}<div class="empty-state" role="status"><p>운영자 권한과 고객 작업을 확인하고 있습니다…</p></div></div>`; return; }
    if (phase === 'denied' || phase === 'error') { root.innerHTML = `<div class="page-container operator-console">${heading()}${statusMarkup()}<div class="empty-state"><h2>${phase === 'denied' ? '운영자 권한이 필요한 공간입니다.' : '작업 공간을 불러오지 못했어요.'}</h2><p>${phase === 'denied' ? '고객사 소유자 권한과 제작 운영자 권한은 별도로 관리됩니다.' : '위 안내를 확인하고 다시 시도해 주세요.'}</p><button class="btn btn-secondary" type="button" data-operator="customer">고객 작업으로 돌아가기</button></div></div>`; return; }
    root.innerHTML = `<div class="page-container operator-console">${heading()}${statusMarkup()}${tenantForm()}${context?.tenants?.length ? `<section class="operator-customer-select"><label class="field" for="operator-tenant"><span>작업할 고객사</span><select id="operator-tenant">${context.tenants.map(tenant => `<option value="${esc(tenant.id)}" ${tenant.id === tenantId ? 'selected' : ''}>${esc(tenant.name)}</option>`).join('')}</select></label><div class="operator-member-list"><p class="eyebrow">배정된 고객 계정</p>${tenantMembers().length ? `<ul>${tenantMembers().map(member => `<li><strong>${esc(memberLabel(member))}</strong><span>${member.active && member.access_allowed ? '접근 허용' : '접근 제한'} · ${esc(member.access_start_date)} ~ ${esc(member.access_end_date)}</span></li>`).join('')}</ul>` : '<p class="muted">배정된 고객 계정이 없습니다.</p>'}</div></section><div class="operator-sections">${uploadForm()}${termsForm()}</div>` : '<div class="empty-state"><h2>첫 고객사를 등록해 주세요.</h2><p>확인된 고객 계정을 배정한 뒤 작업과 영상을 전달할 수 있습니다.</p></div>'}</div>`;
  }
  function displayStatus() { const error = $('.operator-error'), notice = $('.operator-message'); if (error) { error.textContent = problem; error.hidden = !problem; } if (notice) { notice.textContent = message; notice.hidden = !message; } }
  function fail(error) { problem = error?.message || '요청을 처리하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.'; message = ''; displayStatus(); $('.operator-error')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  function setBusy(value) {
    busy = value; root.setAttribute('aria-busy', String(value));
    root.querySelectorAll('input,select,textarea,button,summary').forEach(element => { if (value) { element.dataset.operatorWasDisabled = String(Boolean(element.disabled)); if ('disabled' in element) element.disabled = true; } else if ('disabled' in element) { element.disabled = element.dataset.operatorWasDisabled === 'true'; delete element.dataset.operatorWasDisabled; } });
  }
  async function getContext() {
    const actorId = client.user?.id;
    const data = await rpc(client, 'context');
    if (!actorId || actorId !== client.user?.id) throw new Error('로그인 계정이 변경되었습니다. 현재 계정으로 다시 열어 주세요.');
    if (!data?.operator?.user_id || ![data.tenants, data.members, data.assets].every(Array.isArray)) throw new Error('운영자 작업 목록을 확인할 수 없습니다. 다시 시도해 주세요.');
    context = data; contextUserId = actorId; if (!context.tenants.some(tenant => tenant.id === tenantId)) tenantId = context.tenants[0]?.id || '';
  }
  async function refresh() {
    const sequence = ++requestSequence; phase = 'loading'; busy = true; problem = ''; render();
    try { if (!client.user) await client.restore(); if (sequence !== requestSequence) return; if (!client.user) { phase = 'login'; return; } await getContext(); if (sequence === requestSequence) phase = 'ready'; }
    catch (error) { if (sequence !== requestSequence) return; context = null; phase = error?.code === 'permission' ? 'denied' : 'error'; problem = phase === 'denied' ? '현재 계정에는 제작 운영자 권한이 없습니다. 고객 작업 공간을 이용해 주세요.' : error?.message || '운영자 권한을 확인하지 못했습니다.'; }
    finally { if (sequence === requestSequence) { busy = false; render(); } }
  }
  function open({ focus = true, updateHash = true } = {}) {
    if (contextUserId && contextUserId !== client.user?.id) invalidate();
    active = true; beforeOpen?.(); document.querySelectorAll('section[data-page]').forEach(section => { section.hidden = section !== root; });
    document.querySelectorAll('video').forEach(video => video.pause());
    if (updateHash && location.hash !== '#manage') history.replaceState(null, '', '#manage');
    document.title = '제작 운영 · STAYCUT'; chrome();
    if (!context || phase !== 'ready') refresh(); else render();
    if (focus) { const h1 = $('h1'); h1?.setAttribute('tabindex', '-1'); h1?.focus({ preventScroll: true }); }
  }
  function leave() { active = false; root.hidden = true; nav.hidden = false; caption.textContent = '가상 숙소 · 디자인 시안'; entry.textContent = client.user ? '내 작업' : '로그인'; }
  function invalidate() { ++requestSequence; job?.cancel(); context = null; contextUserId = undefined; tenantId = ''; job = null; phase = 'idle'; problem = ''; message = ''; busy = false; root.innerHTML = ''; }
  function resetJob() { job = null; const button = $('#operator-upload-submit'); if (button) button.textContent = '두 파일 업로드·작업 등록'; $('.operator-progress')?.setAttribute('hidden', ''); }
  function progress({ phase: stage, label, percent }) {
    const box = $('.operator-progress'); if (!box) return;
    box.hidden = false; $('.operator-progress-label').textContent = label;
    const bar = box.querySelector('progress');
    if (['delivery', 'preview', 'done'].includes(stage)) bar.value = percent; else bar.removeAttribute('value');
    $('.operator-progress-hint').textContent = stage === 'commit' ? '서버 검증이 끝날 때까지 기다려 주세요. 파일 전송 완료만으로 등록되지는 않습니다.' : stage === 'done' ? '고객에게는 배정·접근 기간에 따라 작업이 표시됩니다.' : '업로드 중에는 이 화면을 유지해 주세요.';
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-operator]'); if (!button || button.disabled) return;
    if (button.dataset.operator === 'customer') { showCustomer?.(); return; }
    if (button.dataset.operator === 'demo') { showDemo?.(); return; }
    if (button.dataset.operator === 'refresh' && !busy) { job = null; refresh(); }
  });
  root.addEventListener('change', event => {
    if (busy) return;
    if (event.target.id === 'operator-tenant') { tenantId = event.target.value; job = null; message = ''; problem = ''; render(); return; }
    if (event.target.id === 'operator-target') {
      const existing = Boolean(event.target.value); $('#operator-new-job').hidden = existing; $('#operator-existing-job').hidden = !existing;
      $('#operator-new-job').querySelectorAll('input,select').forEach(input => { input.disabled = existing; });
      const asset = tenantAssets().find(item => item.id === event.target.value);
      if (asset) $('#operator-existing-job').innerHTML = `<p><strong>${esc(asset.title)}</strong> · ${asset.latest_version ? `최신 v${esc(asset.latest_version.version_number)}` : '첫 버전 준비 중'}</p><p>기존 승인자·사용 조건·수납 상태를 유지합니다. 조건 변경은 작업 조건 관리에서 저장하세요.</p>${asset.open_revision ? `<p class="operator-feedback">${esc(asset.open_revision.message)}</p><label class="check-field"><input name="revisionReviewed" type="checkbox" required><span>위 수정 요청을 확인하고 새 버전에 반영했습니다. 등록 시 이 요청이 처리됩니다.</span></label>` : '<p>현재 미해결 수정 요청이 없습니다.</p>'}`;
      else $('#operator-existing-job').innerHTML = '';
    }
    if (event.target.id === 'operator-terms-asset') { const asset = tenantAssets().find(item => item.id === event.target.value); if (asset) $('#operator-terms-fields').innerHTML = termsFields(assetTerms(asset), 'operator-edit'); }
    if (event.target.closest('#operator-upload-form')) resetJob();
  });
  root.addEventListener('input', event => { if (!busy && event.target.closest('#operator-upload-form')) resetJob(); });
  root.addEventListener('submit', async event => {
    const form = event.target; if (!['operator-tenant-form', 'operator-upload-form', 'operator-terms-form'].includes(form.id)) return;
    event.preventDefault(); if (busy) return;
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const data = new FormData(form); problem = ''; message = ''; displayStatus();
    const sequence = requestSequence, actorId = client.user?.id;
    const current = () => sequence === requestSequence && actorId === client.user?.id;
    try {
      if (form.id === 'operator-tenant-form') {
        const input = { name: String(data.get('name') || '').trim(), customerEmail: String(data.get('customerEmail') || '').trim(), accessStartDate: String(data.get('accessStartDate') || ''), accessEndDate: String(data.get('accessEndDate') || '') };
        if (!input.name || !validDate(input.accessStartDate) || !validDate(input.accessEndDate) || input.accessStartDate > input.accessEndDate) throw new Error('고객사 이름과 접근 기간을 확인해 주세요.');
        setBusy(true); const result = await rpc(client, 'createTenant', input); if (!current()) return;
        await getContext(); tenantId = result?.tenantId || result?.tenant?.id || context.tenants.find(tenant => tenant.name === input.name)?.id || tenantId;
        message = '고객사를 등록하고 확인된 계정을 배정했습니다.'; phase = 'ready'; busy = false; render(); return;
      }
      if (form.id === 'operator-terms-form') {
        const input = { assetId: String(data.get('assetId') || ''), terms: readTerms(data) };
        setBusy(true); await rpc(client, 'updateAsset', input); if (!current()) return; await getContext();
        message = '작업의 접근·이용허락·수납 조건을 저장했습니다.'; phase = 'ready'; busy = false; render(); return;
      }
      const existingId = String(data.get('assetId') || '');
      const input = { tenantId, assetId: existingId || null, changeSummary: String(data.get('changeSummary') || '').trim() };
      if (existingId) {
        const asset = tenantAssets().find(item => item.id === existingId);
        if (!asset) throw new Error('현재 고객사의 작업을 다시 선택해 주세요.');
        if (asset.open_revision && data.get('revisionReviewed') !== 'on') throw new Error('기존 수정 요청을 확인하고 반영 여부에 체크해 주세요.');
        input.expectedRevisionId = asset.open_revision?.id || null;
        input.expectedLatestVersionId = asset.latest_version_id || null;
      }
      if (!existingId) {
        input.title = String(data.get('title') || '').trim(); input.assignedApproverId = String(data.get('assignedApproverId') || ''); input.terms = readTerms(data);
        if (!input.title || !UUID.test(input.assignedApproverId)) throw new Error('작업 제목과 지정 승인자를 확인해 주세요.');
      }
      if (data.get('previewConfirmed') !== 'on') throw new Error('별도로 제작한 검토용 영상의 확인 항목에 체크해 주세요.');
      if (!job) job = createVideoUploadJob({ client, input, deliveryFile: data.get('deliveryFile'), previewFile: data.get('previewFile'), onProgress: progress });
      setBusy(true); await job.run(); if (!current()) return; job = null;
      message = '두 영상의 실제 파일 검증을 마치고 새 버전을 등록했습니다.';
      try { await getContext(); phase = 'ready'; busy = false; render(); }
      catch { message = '영상과 작업은 등록되었습니다. 최신 목록은 새로고침해서 확인해 주세요.'; problem = ''; displayStatus(); }
    } catch (error) {
      if (!current()) return;
      fail(error);
      const button = $('#operator-upload-submit'); if (job && button) button.textContent = '업로드·등록 다시 시도';
      const hint = $('.operator-progress-hint'); if (hint && job) hint.textContent = '입력과 파일을 유지했습니다. 전송 실패는 새 경로에 다시 업로드하고, 최종 등록 실패는 서버 검증을 다시 요청합니다.';
    } finally { if (current()) setBusy(false); }
  });
  client.subscribe?.(user => {
    const nextId = user?.id;
    if (nextId === observedUserId) return;
    observedUserId = nextId;
    if (nextId && phase === 'loading' && !context && !job) return;
    invalidate();
    if (active) { if (user) refresh(); else render(); }
  });
  return { open, leave, invalidate };
}
