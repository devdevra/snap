const SESSION_KEY = 'staycut.customer.session.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { instagram: 'Instagram', youtube: 'YouTube', organic: '자체 SNS 일반 게시', advertising: '유료 광고' };
const reviewLabels = { pending: '검토 대기', approved: '내용 승인됨', revision_requested: '수정 요청됨' };
const koreanToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export class PortalError extends Error {
  constructor(message, code = '') { super(message); this.code = code; }
}

function transportError(status, data, auth = false) {
  const code = data?.code || data?.error_code || '';
  if (['PGRST205', 'PGRST202', '42P01', '42883'].includes(code)) return new PortalError('고객 데이터베이스 설정이 아직 완료되지 않았습니다. 운영자에게 데이터베이스 구성을 요청해 주세요.', 'setup');
  if (status === 401 || (auth && status === 400)) return new PortalError(auth ? '이메일과 비밀번호를 확인해 주세요. 초대된 계정으로 로그인할 수 있습니다.' : '로그인이 만료되었습니다. 다시 로그인해 주세요.', 'auth');
  if (code === '55000') return new PortalError('작업 상태 또는 사용 조건이 변경되었습니다. 새로고침한 뒤 현재 버전을 확인해 주세요.', 'state');
  if (status === 403 || code === '42501') return new PortalError('이 작업에 대한 권한이 없습니다. 고객사 배정과 접근 기간을 운영자에게 확인해 주세요.', 'permission');
  if (status === 429) return new PortalError('요청이 많습니다. 잠시 후 다시 시도해 주세요.', 'rate');
  if (status === 503) return new PortalError('파일 서버 설정이 아직 완료되지 않았습니다. 운영자에게 문의해 주세요.', 'setup');
  return new PortalError(auth ? '로그인 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' : '요청을 처리하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.', code);
}

/** No service key, fictional fixtures, or direct database writes enter this client. */
export function createPortalClient({ fetchImpl = globalThis.fetch, storage, clock = () => Date.now() } = {}) {
  let config;
  let session;
  let refreshPromise;
  let configPromise;
  let authGeneration = 0;
  let storageImpl = storage;
  const sessionListeners = new Set();
  const notifySession = user => {
    for (const listener of sessionListeners) { try { listener(user); } catch { /* UI observers cannot prevent session cleanup. */ } }
  };
  if (storage === undefined) { try { storageImpl = globalThis.sessionStorage; } catch { storageImpl = null; } }
  const clear = () => { authGeneration += 1; session = null; try { storageImpl?.removeItem(SESSION_KEY); } catch { /* Memory-only sessions remain usable. */ } notifySession(null); };
  const ensureGeneration = generation => {
    if (generation !== authGeneration) throw new PortalError('로그인 계정이 변경되었습니다. 현재 계정에서 다시 시도해 주세요.', 'auth_changed');
  };
  const persist = () => { try { storageImpl?.setItem(SESSION_KEY, JSON.stringify({ origin: config.origin, ...session })); } catch { /* A disabled storage does not block sign-in. */ } };
  const validToken = value => typeof value === 'string' && value.length <= 8192 && JWT.test(value);
  const validRefresh = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\x00-\x1f]/.test(value);

  async function json(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error', cache: 'no-store' });
      let data;
      try { data = await response.json(); } catch { data = null; }
      return { ok: response.ok, status: response.status, data };
    } catch { throw new PortalError('서비스에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.', 'network'); }
    finally { clearTimeout(timer); }
  }

  async function configure() {
    if (config) return config;
    if (!configPromise) configPromise = (async () => {
      let result = await json('/api/config');
      if (result.status === 404) result = await json('./public-config.json');
      try {
        if (!result.ok) throw new Error();
        const parsed = new URL(result.data?.supabaseUrl);
        const key = result.data?.publishableKey;
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
          || typeof key !== 'string' || key.length > 8192 || /\s/.test(key) || (!key.startsWith('sb_publishable_') && !JWT.test(key))) throw new Error();
        config = { origin: parsed.origin, key };
        return config;
      } catch { throw new PortalError('로그인 연결 설정을 확인하고 있습니다. 디자인 체험 화면은 계속 이용할 수 있어요.', 'setup'); }
    })().finally(() => { configPromise = null; });
    return configPromise;
  }

  function acceptSession(data) {
    if (!validToken(data?.access_token) || !validRefresh(data?.refresh_token) || !UUID.test(data?.user?.id || '')) throw new PortalError('로그인 응답을 확인할 수 없습니다. 다시 로그인해 주세요.', 'auth');
    const expires = Number(data.expires_at) || Math.floor(clock() / 1000) + Number(data.expires_in || 3600);
    if (!Number.isFinite(expires)) throw new PortalError('로그인 응답을 확인할 수 없습니다.', 'auth');
    const previousId = session?.user?.id;
    session = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expires, user: { id: data.user.id, email: data.user.email || '' } };
    persist();
    if (previousId !== session.user.id) notifySession(session.user);
    return session.user;
  }

  async function refresh() {
    if (!session) throw new PortalError('다시 로그인해 주세요.', 'auth');
    if (!refreshPromise) refreshPromise = (async () => {
      const generation = authGeneration;
      const result = await json(`${config.origin}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      ensureGeneration(generation);
      if (!result.ok) { if ([400, 401, 403].includes(result.status)) clear(); throw transportError(result.status, result.data, true); }
      return acceptSession(result.data);
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function authenticated(path, options = {}, safeApiMessage = false, timeoutMs = 15000) {
    await configure();
    if (!session) throw new PortalError('다시 로그인해 주세요.', 'auth');
    const generation = authGeneration;
    if (session.expires_at * 1000 < clock() + 60000) await refresh();
    ensureGeneration(generation);
    const request = () => json(path.startsWith('/api/') ? path : `${config.origin}${path}`, {
      ...options, headers: { apikey: config.key, Authorization: `Bearer ${session.access_token}`, ...options.headers },
    }, timeoutMs);
    let result = await request();
    ensureGeneration(generation);
    if (result.status === 401) { await refresh(); ensureGeneration(generation); result = await request(); ensureGeneration(generation); }
    if (!result.ok) {
      if (result.status === 401) clear();
      const problem = transportError(result.status, result.data);
      if (safeApiMessage && result.status !== 401 && typeof result.data?.error === 'string'
        && result.data.error.length > 0 && result.data.error.length <= 400) problem.message = result.data.error;
      throw problem;
    }
    return result.data;
  }

  return {
    configure,
    get user() { return session?.user; },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Session listener must be a function.');
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    request(path, options = {}) {
      if (path !== '/api/operator') throw new PortalError('지원하지 않는 요청입니다.');
      return authenticated(path, options, true, 170000);
    },
    async restore() {
      const generation = ++authGeneration;
      await configure();
      ensureGeneration(generation);
      let saved;
      try { saved = JSON.parse(storageImpl?.getItem(SESSION_KEY) || 'null'); } catch { clear(); return null; }
      if (!saved) return null;
      if (saved.origin !== config.origin || !validToken(saved.access_token) || !validRefresh(saved.refresh_token) || !Number.isFinite(saved.expires_at)) { clear(); return null; }
      const previousId = session?.user?.id;
      session = { ...saved, user: undefined };
      try {
        const user = await authenticated('/auth/v1/user');
        if (!UUID.test(user?.id || '')) throw new PortalError('다시 로그인해 주세요.', 'auth');
        session.user = { id: user.id, email: user.email || '' }; persist();
        if (previousId !== session.user.id) notifySession(session.user);
        return session.user;
      } catch (error) { if (generation === authGeneration) clear(); throw error; }
    },
    async signIn(email, password) {
      const generation = ++authGeneration;
      await configure();
      ensureGeneration(generation);
      const result = await json(`${config.origin}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
      });
      ensureGeneration(generation);
      if (!result.ok) throw transportError(result.status, result.data, true);
      return acceptSession(result.data);
    },
    async signOut() {
      const generation = authGeneration;
      try { if (session) await authenticated('/auth/v1/logout?scope=local', { method: 'POST' }); } finally { if (generation === authGeneration) clear(); }
    },
    async listAssets() {
      const tables = [
        ['tenants', 'id,name'],
        ['assets', 'id,tenant_id,title,assigned_approver_id,latest_version_id,rights_status,rights_start_date,rights_end_date,allowed_channels,allowed_purposes,final_delivery_paid,access_end_date'],
        ['asset_versions', 'id,asset_id,tenant_id,version_number,review_status,change_summary,preview_available,delivery_available,created_at'],
        ['version_approvals', 'version_id,approved_at,channel,purpose'],
        ['revision_requests', 'asset_id,version_id,message,requested_at,resolved_at'],
      ];
      const [tenants, assets, versions, approvals, revisions] = await Promise.all(tables.map(([table, select]) => authenticated(`/rest/v1/${table}?select=${select}&order=${table === 'tenants' ? 'name' : table === 'version_approvals' ? 'approved_at.desc' : table === 'revision_requests' ? 'requested_at.desc' : 'created_at.desc'}`)));
      if (![tenants, assets, versions, approvals, revisions].every(Array.isArray)) throw new PortalError('작업 목록 응답을 확인할 수 없습니다. 다시 시도해 주세요.');
      return assets.map(asset => ({ ...asset, tenantName: tenants.find(tenant => tenant.id === asset.tenant_id)?.name || '고객 작업', version: versions.find(version => version.id === asset.latest_version_id), approval: approvals.find(approval => approval.version_id === asset.latest_version_id), revision: revisions.find(revision => revision.asset_id === asset.id && !revision.resolved_at) }));
    },
    approve(versionId, channel, purpose, confirmed, feedback) {
      return authenticated('/rest/v1/rpc/approve_asset_version', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_version_id: versionId, p_channel: channel, p_purpose: purpose, p_confirmed: confirmed, p_feedback: feedback }) });
    },
    revise(versionId, message) {
      return authenticated('/rest/v1/rpc/request_asset_revision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_version_id: versionId, p_message: message }) });
    },
    async media(kind, versionId, channel, purpose) {
      const data = await authenticated(`/api/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kind === 'preview' ? { versionId } : { versionId, channel, purpose }) });
      let url;
      try {
        url = new URL(data?.url);
        if (url.protocol !== 'https:' || url.origin !== config.origin || !url.pathname.startsWith('/storage/v1/object/sign/staycut-deliverables/') || !url.searchParams.get('token') || url.username || url.password || url.hash) throw new Error();
      } catch { throw new PortalError('파일 링크를 확인할 수 없습니다. 다시 시도해 주세요.'); }
      return url.href;
    },
  };
}

export function initCustomerPortal({ showDemo, beforeOpen, onNavigate, client = createPortalClient() } = {}) {
  const root = document.querySelector('#customer-portal');
  const entry = document.querySelector('#account-entry');
  const nav = document.querySelector('#app-nav');
  const caption = document.querySelector('.header-caption');
  const footerNote = document.querySelector('.site-footer p:last-child');
  let active = false;
  let initialized = false;
  let busy = false;
  let assets = [];
  let selectedId;
  let message = '';
  let problem = '';
  let phase = 'login';
  let loadGeneration = 0;
  const drafts = new Map();
  const viewed = new Set();
  client.subscribe(() => {
    loadGeneration += 1; busy = false;
    assets = []; selectedId = null; drafts.clear(); viewed.clear();
    if (!client.user) { initialized = false; phase = 'login'; }
    if (active) render(); else root.replaceChildren();
  });
  const $ = selector => root.querySelector(selector);
  const selected = () => assets.find(asset => asset.id === selectedId);
  const draft = asset => {
    const id = asset?.version?.id;
    if (!drafts.has(id)) drafts.set(id, { text: '', confirmed: false, channel: asset?.allowed_channels?.includes('instagram') ? 'instagram' : asset?.allowed_channels?.[0] || '', purpose: asset?.allowed_purposes?.includes('organic') ? 'organic' : asset?.allowed_purposes?.[0] || '' });
    return drafts.get(id);
  };
  const status = () => `<p class="customer-message" role="status" ${message ? '' : 'hidden'}>${esc(message)}</p><p class="form-error customer-error" role="alert" ${problem ? '' : 'hidden'}>${esc(problem)}</p>`;
  const focusHeading = () => { const heading = $('h1'); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); };

  function setChrome() {
    root.hidden = !active;
    nav.hidden = active;
    entry.textContent = active ? '체험 화면' : client.user ? '내 작업' : '로그인';
    caption.textContent = active ? '실제 고객 작업 공간' : '가상 숙소 · 디자인 시안';
    footerNote.textContent = active ? '로그인한 계정에 허용된 작업을 표시합니다. 내용 승인과 실제 게시는 별도입니다.' : '가상 숙소 체험 화면입니다. 입력과 승인은 실제 고객에게 전달되지 않습니다.';
  }

  function renderLogin() {
    root.innerHTML = `<div class="customer-login"><div class="customer-intro"><p class="eyebrow">YOUR STAY, YOUR STORY</p><h1>숙소의 다음 이야기,<br>함께 준비해요.</h1><p>전달받은 영상을 검토하고,<br>승인한 콘텐츠를 안전하게 내려받으세요.</p><p class="muted">실제 고객 계정 전용 작업 공간입니다.<br>디자인 체험의 입력·승인은 여기에 저장되지 않습니다.</p></div><div class="customer-login-card"><p class="eyebrow">CUSTOMER SIGN IN</p><h2>고객 로그인</h2><p class="muted">운영자가 초대한 계정으로 로그인해 주세요.<br>계정 생성·비밀번호 재설정은 운영자에게 문의해 주세요.</p><form id="customer-login-form"><label class="field" for="customer-email"><span>이메일</span><input id="customer-email" name="email" type="email" autocomplete="username" maxlength="254" required ${busy ? 'disabled' : ''}></label><label class="field" for="customer-password"><span>비밀번호</span><input id="customer-password" name="password" type="password" autocomplete="current-password" required ${busy ? 'disabled' : ''}></label>${status()}<button class="btn btn-primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? '로그인 중…' : '로그인'}</button></form><button class="text-link customer-demo-link" type="button" data-customer="demo">디자인 체험 화면 보기 <img class="icon" src="assets/icons/arrow-right.svg" alt=""></button></div></div>`;
  }

  function allowed(asset) {
    const d = draft(asset), today = koreanToday();
    return asset.rights_status === 'valid' && asset.rights_start_date <= today && today <= asset.rights_end_date && asset.allowed_channels.includes(d.channel) && asset.allowed_purposes.includes(d.purpose);
  }

  function approvalReason(asset) {
    if (!asset.version) return '검토할 버전이 아직 없습니다.';
    if (asset.version.review_status !== 'pending') return '현재 버전의 검토 상태를 확인해 주세요.';
    if (asset.assigned_approver_id !== client.user?.id) return '지정된 승인자만 승인·수정 요청을 남길 수 있습니다.';
    if (asset.revision) return '제작자가 기존 수정 요청을 처리한 뒤 승인할 수 있습니다.';
    if (!allowed(asset)) return '허용된 사용 범위와 이용 기간을 확인해 주세요.';
    if (!asset.version.preview_available || !viewed.has(asset.version.id)) return '미리보기를 불러와 영상과 문구를 확인해 주세요.';
    if (draft(asset).text.trim()) return '작성한 수정사항을 요청하거나 지운 뒤 승인해 주세요.';
    if (!draft(asset).confirmed) return '아래 확인 항목에 체크해 주세요.';
    return '';
  }

  function detailMarkup(asset) {
    const version = asset.version;
    if (!version) return '<div class="empty-state"><h2>첫 버전을 준비하고 있어요.</h2><p>제작자가 파일을 전달하면 이곳에서 검토할 수 있습니다.</p></div>';
    const d = draft(asset), assigned = asset.assigned_approver_id === client.user?.id;
    const pending = version.review_status === 'pending';
    const downloadable = version.review_status === 'approved' && version.delivery_available && asset.final_delivery_paid && allowed(asset);
    return `<div class="review-version-heading"><div><p class="eyebrow">${esc(asset.tenantName)} · VERSION ${esc(version.version_number)}</p><h2>${esc(asset.title)}</h2></div><span class="status-pill ${version.review_status === 'approved' ? 'is-approved' : ''}">${esc(reviewLabels[version.review_status] || '제작 중')}</span></div><div class="review-layout customer-review-layout"><div class="review-media"><div id="customer-player" class="customer-player"><img class="customer-media-icon" src="assets/icons/film-strip.svg" alt=""><p>이 작업의 실제 전달 파일</p><button class="btn btn-secondary" type="button" data-customer="preview" ${version.preview_available && !busy ? '' : 'disabled'}>${version.preview_available ? '영상 미리보기 불러오기' : '미리보기 준비 중'}</button><p class="media-demo-note">미리보기는 일시적인 비공개 링크로 열립니다.</p></div></div><div class="review-inspector"><section class="inspector-section"><h3 class="section-title">이번 버전 안내</h3><p class="customer-preserve">${esc(version.change_summary || '제작자가 안내 문구를 등록하지 않았습니다.')}</p></section><section class="inspector-section"><h3 class="section-title">사용 조건</h3><dl class="metadata-list"><div><dt>이용허락</dt><dd>${asset.rights_status === 'valid' ? '확인됨 · 기간·범위 확인 필요' : '확인 필요'}</dd></div><div><dt>사용 기간</dt><dd>${esc(asset.rights_start_date)} ~ ${esc(asset.rights_end_date)}</dd></div><div><dt>파일 접근 종료</dt><dd>${esc(asset.access_end_date)}</dd></div><div><dt>수납</dt><dd>${asset.final_delivery_paid ? '최종 전달 수납 확인됨' : '최종 전달 수납 확인 전'}</dd></div></dl><div class="customer-scope"><label class="field" for="customer-channel"><span>사용 채널</span><select id="customer-channel" ${busy ? 'disabled' : ''}>${asset.allowed_channels.length ? asset.allowed_channels.map(channel => `<option value="${esc(channel)}" ${channel === d.channel ? 'selected' : ''}>${esc(labels[channel] || channel)}</option>`).join('') : '<option value="">허용 채널 확인 필요</option>'}</select></label><label class="field" for="customer-purpose"><span>사용 목적</span><select id="customer-purpose" ${busy ? 'disabled' : ''}>${asset.allowed_purposes.length ? asset.allowed_purposes.map(purpose => `<option value="${esc(purpose)}" ${purpose === d.purpose ? 'selected' : ''}>${esc(labels[purpose] || purpose)}</option>`).join('') : '<option value="">허용 목적 확인 필요</option>'}</select></label></div></section>${pending && assigned ? `<form id="customer-review-form"><section class="inspector-section"><h3 class="section-title">수정할 내용이 있나요?</h3><label class="field" for="customer-feedback"><span>통합 수정사항</span><textarea id="customer-feedback" rows="4" maxlength="4000" ${busy ? 'disabled' : ''}>${esc(d.text)}</textarea></label><p class="muted">제출 전 초안은 이 화면에서만 유지되며, 새로고침하면 사라집니다.</p><button class="btn btn-secondary" type="button" data-customer="revise" ${busy ? 'disabled' : ''}>수정 요청 보내기</button></section><section class="approval-panel"><h3 class="section-title">이 버전으로 괜찮으신가요?</h3><label class="check-field" for="customer-confirm"><input id="customer-confirm" type="checkbox" ${d.confirmed ? 'checked' : ''} ${busy ? 'disabled' : ''}><span><strong>${esc(asset.title)} v${esc(version.version_number)}</strong>의 화면·문구·실제 시설·제공 서비스·노출 인물을 확인했습니다.</span></label><p id="customer-approval-help" class="muted">${esc(approvalReason(asset) || '서버에서 현재 버전과 권한을 다시 확인한 뒤 승인합니다.')}</p><button class="btn btn-primary" id="customer-approve" type="submit" ${busy || approvalReason(asset) ? 'disabled' : ''}>${busy ? '저장 중…' : `v${esc(version.version_number)} 이 버전 승인`}</button></section></form>` : version.review_status === 'revision_requested' ? `<section class="approval-panel"><h3 class="section-title">수정 요청이 전달되었어요.</h3><p class="feedback-saved">${esc(asset.revision?.message || '수정 요청 내용을 준비하고 있습니다.')}</p><p class="muted">이 버전은 승인되지 않았습니다. 새 버전이 도착하면 다시 확인해 주세요.</p></section>` : version.review_status === 'approved' ? `<section class="approval-panel"><h3 class="section-title">v${esc(version.version_number)} 내용 승인 완료</h3><p class="muted">${asset.approval ? `${esc(asset.approval.approved_at.slice(0, 10))} · ${esc(labels[asset.approval.channel])} · ${esc(labels[asset.approval.purpose])}` : '승인 이력을 확인하고 있습니다.'}</p><button class="btn btn-primary" type="button" data-customer="download" ${downloadable && !busy ? '' : 'disabled'}>게시용 파일 다운로드</button><p class="muted">${downloadable ? '다운로드 시 서버에서 최신 승인·수납·사용 조건을 다시 확인합니다.' : '현재 사용 범위·수납·전달 파일 준비 상태를 확인해 주세요.'}</p><p class="muted">다운로드와 실제 게시는 별도입니다. 게시 기록·재편집 문의 저장은 준비 중입니다.</p></section>` : '<p class="notice">지정된 승인자만 승인·수정 요청을 남길 수 있습니다.</p>'}</div></div>`;
  }

  function renderWorkspace() {
    const asset = selected();
    root.innerHTML = `<div class="page-container customer-workspace"><div class="page-heading"><div><p class="eyebrow">YOUR NEXT STORY</p><h1>우리 숙소의 이야기,<br>다음 장면을 준비해요.</h1><p class="muted">${esc(client.user?.email || '로그인한 고객')} · 실제 고객 작업</p></div><div class="customer-toolbar"><button class="btn btn-secondary" type="button" data-customer="reload" ${busy ? 'disabled' : ''}>새로고침</button><button class="text-link" type="button" data-customer="logout" ${busy ? 'disabled' : ''}>로그아웃</button></div></div>${status()}${phase === 'loading' ? '<div class="empty-state" role="status"><p>접근 가능한 작업을 불러오고 있습니다…</p></div>' : phase === 'error' ? '<div class="empty-state"><h2>작업을 불러오지 못했어요.</h2><p>위 안내를 확인한 뒤 새로고침해 주세요.</p></div>' : assets.length ? `<div class="tabs customer-tabs" aria-label="접근 가능한 작업">${assets.map(item => `<button type="button" data-customer="select" data-id="${esc(item.id)}" aria-pressed="${item.id === asset?.id}" class="${item.id === asset?.id ? 'is-active' : ''}" ${busy ? 'disabled' : ''}>${esc(item.title)}<small>${esc(item.tenantName)} · ${esc(item.version ? `v${item.version.version_number} · ${reviewLabels[item.version.review_status]}` : '첫 버전 준비 중')}</small></button>`).join('')}</div>${asset ? detailMarkup(asset) : ''}` : '<div class="empty-state"><h2>아직 배정된 작업이 없어요.</h2><p>운영자가 고객사 멤버십·접근 기간과 작업을 배정하면 이곳에 표시됩니다.</p><p>디자인 체험의 가상 숙소와 파일은 실제 계정에 추가되지 않습니다.</p></div>'}</div>`;
  }

  function render() {
    if (!active) return;
    setChrome();
    if (client.user) renderWorkspace(); else renderLogin();
  }
  function showStatus() {
    const notice = $('.customer-message'), error = $('.customer-error');
    if (notice) { notice.textContent = message; notice.hidden = !message; }
    if (error) { error.textContent = problem; error.hidden = !problem; }
  }
  function updateControls() {
    const asset = selected();
    if (!asset) return;
    const button = $('#customer-approve'), help = $('#customer-approval-help');
    if (button) button.disabled = busy || Boolean(approvalReason(asset));
    if (help) help.textContent = approvalReason(asset) || '서버에서 현재 버전과 권한을 다시 확인한 뒤 승인합니다.';
    const download = $('[data-customer="download"]');
    if (download) download.disabled = busy || asset.version?.review_status !== 'approved' || !asset.version?.delivery_available || !asset.final_delivery_paid || !allowed(asset);
  }
  function displayError(error) {
    problem = error instanceof PortalError ? error.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.';
    message = '';
    if (!client.user) { phase = 'login'; assets = []; selectedId = null; drafts.clear(); viewed.clear(); render(); }
    else showStatus();
  }
  async function load() {
    const generation = ++loadGeneration;
    const userId = client.user?.id;
    busy = true; phase = 'loading'; problem = ''; render();
    try {
      const next = await client.listAssets();
      if (generation !== loadGeneration || client.user?.id !== userId) return;
      assets = next;
      if (!assets.some(asset => asset.id === selectedId)) selectedId = assets[0]?.id;
      phase = 'ready';
    } catch (error) { if (generation === loadGeneration && client.user?.id === userId) { phase = 'error'; displayError(error); } }
    finally { if (generation === loadGeneration) { busy = false; render(); } }
  }
  async function initialize() {
    if (initialized) return;
    initialized = true; busy = true; message = '로그인 연결을 확인하고 있습니다…'; render();
    try { await client.restore(); message = ''; if (client.user) await load(); }
    catch (error) { displayError(error); }
    finally { busy = false; render(); }
  }
  function pause() { root.querySelectorAll('video').forEach(video => video.pause()); }
  function open({ focus = true, updateHash = true } = {}) {
    active = true; beforeOpen?.();
    document.querySelectorAll('section[data-page]').forEach(section => { section.hidden = section !== root; });
    document.querySelectorAll('video').forEach(video => video.pause());
    if (updateHash && location.hash !== '#account') history.replaceState(null, '', '#account');
    document.title = '고객 작업 공간 · STAYCUT';
    render(); if (focus) focusHeading();
    if (initialized && client.user) load(); else initialize();
  }
  function leave() { pause(); active = false; setChrome(); }
  entry.addEventListener('click', () => {
    if (onNavigate) onNavigate(active ? 'home' : 'account');
    else if (active) showDemo?.(); else open();
  });

  root.addEventListener('input', event => {
    const asset = selected();
    if (event.target.id === 'customer-feedback' && asset) { draft(asset).text = event.target.value; draft(asset).confirmed = false; const checkbox = $('#customer-confirm'); if (checkbox) checkbox.checked = false; updateControls(); }
  });
  root.addEventListener('change', event => {
    const asset = selected(); if (!asset) return;
    if (event.target.id === 'customer-confirm') draft(asset).confirmed = event.target.checked;
    if (['customer-channel', 'customer-purpose'].includes(event.target.id)) {
      draft(asset)[event.target.id === 'customer-channel' ? 'channel' : 'purpose'] = event.target.value;
      draft(asset).confirmed = false; const checkbox = $('#customer-confirm'); if (checkbox) checkbox.checked = false;
    }
    updateControls();
  });
  root.addEventListener('submit', async event => {
    if (!['customer-login-form', 'customer-review-form'].includes(event.target.id)) return;
    event.preventDefault(); if (busy) return;
    if (event.target.id === 'customer-login-form') {
      const data = new FormData(event.target);
      const email = String(data.get('email') || '').trim(); const password = String(data.get('password') || '');
      if (!email || !password || !event.target.checkValidity()) { event.target.reportValidity(); return; }
      busy = true; problem = ''; message = ''; render();
      try { await client.signIn(email, password); await load(); focusHeading(); }
      catch (error) { displayError(error); }
      finally { busy = false; render(); }
      return;
    }
    const asset = selected();
    if (!asset || approvalReason(asset)) { updateControls(); return; }
    await mutate('approve', asset);
  });

  async function mutate(kind, asset) {
    const versionId = asset.version.id, d = draft(asset);
    if (kind === 'revise' && !d.text.trim()) { problem = '수정할 내용을 입력해 주세요.'; message = ''; showStatus(); $('#customer-feedback')?.focus(); return; }
    busy = true; problem = ''; message = ''; updateControls();
    root.querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = true; });
    let saved = false;
    try {
      if (kind === 'approve') await client.approve(versionId, d.channel, d.purpose, d.confirmed, d.text);
      else await client.revise(versionId, d.text.trim());
      saved = true; drafts.delete(versionId); viewed.delete(versionId);
      const next = await client.listAssets(); assets = next;
      message = kind === 'approve' ? '이 버전의 내용 승인을 서버에 저장했습니다.' : '수정 요청을 서버에 저장했습니다. 이 버전은 승인되지 않았습니다.';
      phase = 'ready';
    } catch (error) {
      if (saved) { assets = []; phase = 'error'; problem = '요청은 서버에 저장되었습니다. 최신 목록을 불러오지 못했으니 새로고침해 주세요.'; }
      else displayError(error);
    } finally { busy = false; render(); }
  }

  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-customer]'); if (!button || button.disabled) return;
    const action = button.dataset.customer;
    if (action === 'demo') { showDemo?.(); return; }
    if (busy) return;
    if (action === 'select') { pause(); selectedId = button.dataset.id; message = ''; problem = ''; render(); return; }
    if (action === 'reload') { message = ''; viewed.clear(); await load(); return; }
    if (action === 'logout') {
      busy = true; pause();
      try { await client.signOut(); message = '로그아웃했습니다.'; problem = ''; }
      catch { message = '이 탭에서 로그아웃했습니다. 서버 연결을 확인하지 못해 다른 세션은 유지될 수 있습니다.'; problem = ''; }
      finally { busy = false; assets = []; selectedId = null; drafts.clear(); viewed.clear(); render(); focusHeading(); }
      return;
    }
    const asset = selected(); if (!asset?.version) return;
    if (action === 'revise') { await mutate('revise', asset); return; }
    if (!['preview', 'download'].includes(action)) return;
    const versionId = asset.version.id, d = draft(asset);
    button.disabled = true; problem = ''; message = action === 'preview' ? '비공개 미리보기를 준비하고 있습니다…' : '다운로드 권한을 확인하고 있습니다…'; showStatus();
    try {
      const url = await client.media(action, versionId, d.channel, d.purpose);
      if (selected()?.version?.id !== versionId || !active) return;
      if (action === 'preview') {
        const player = $('#customer-player');
        player.innerHTML = '<video controls playsinline preload="metadata" aria-label="현재 버전 영상 미리보기"></video><button class="btn btn-secondary" type="button" data-customer="preview">미리보기 다시 불러오기</button><p class="media-demo-note">링크 만료 또는 재생 오류 시 다시 불러와 주세요.</p>';
        const video = player.querySelector('video');
        video.addEventListener('loadedmetadata', () => { if (selected()?.version?.id === versionId) { viewed.add(versionId); message = '영상을 재생하고 화면·문구를 확인해 주세요.'; showStatus(); updateControls(); } });
        video.addEventListener('error', () => { viewed.delete(versionId); problem = '영상을 재생하지 못했습니다. 미리보기를 다시 불러와 주세요.'; message = ''; showStatus(); updateControls(); });
        video.src = url;
        message = '미리보기를 불러왔습니다. 영상을 재생해 확인해 주세요.';
      } else {
        const link = document.createElement('a'); link.href = url; link.rel = 'noopener noreferrer'; link.download = ''; link.target = '_blank'; document.body.append(link); link.click(); link.remove();
        message = '비공개 파일 링크를 열었습니다. 다운로드는 게시 완료를 뜻하지 않습니다.';
      }
      showStatus();
    } catch (error) { displayError(error); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  return { open, leave };
}
