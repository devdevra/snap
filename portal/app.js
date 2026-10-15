import {
  CHANNELS, PURPOSES, DEMO_DATE, createInitialState, canApprove, canDownload,
  approvalBlockReason, downloadBlockReason, rightsBlockReason, accessBlockReason,
  validDate, validOptionalUrl,
} from './domain.js';

const state = createInitialState();
const $ = (selector, root = document) => root.querySelector(selector);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name) => `<img class="icon" src="assets/icons/${name}.svg" alt="" aria-hidden="true">`;
const assetById = (id) => state.assets.find((asset) => asset.id === id);
const currentOptions = () => ({ date: DEMO_DATE, channel: state.channel, purpose: state.purpose });
const duration = (seconds) => `00:${String(seconds).padStart(2, '0')}`;
const labelStatus = (asset) => ({ pending: '검토 대기', approved: '내용 승인됨', revision_requested: '수정 요청됨' }[asset.approvalStatus] || '제작 중');
const displayDate = (date) => date ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(date)) : '';
const now = () => new Date().toISOString();
const statusPill = (asset) => `<span class="status-pill ${asset.approvalStatus === 'approved' ? 'is-approved' : ''}">${escape(labelStatus(asset))} · v${asset.version}</span>`;
let toastTimer;
let modalReturnFocus;

function toast(message) {
  const element = $('#toast');
  if (!element) return;
  clearTimeout(toastTimer);
  element.textContent = message;
  element.classList.add('is-visible');
  toastTimer = setTimeout(() => { element.classList.remove('is-visible'); }, 5000);
}

function publicationText(asset, channel = 'instagram') {
  const record = asset.publicationResponses.find((response) => response.channel === channel);
  if (!record) return '게시 여부 미확인';
  return record.status === 'published' ? '운영자가 게시했다고 확인' : '아직 게시하지 않음';
}

function card(asset, compact = false) {
  const ready = canDownload(asset, currentOptions());
  return `<article class="asset-card ${compact ? 'asset-card-compact' : ''}">
    <button class="asset-thumb" data-action="preview" data-id="${asset.id}" aria-label="${escape(asset.title)} v${asset.version} 샘플 영상 미리보기">
      <img src="${asset.image}" alt="가상 온유스테이의 ${escape(asset.title)} 장면" loading="lazy">
      <span class="duration">${icon('play')} ${duration(asset.duration)}</span>
    </button>
    <div class="asset-body"><h3 class="asset-title">${escape(asset.title)}</h3>
      ${compact ? `<p class="asset-facts approved-fact">${icon('check-circle')} 승인 완료 · 자체 SNS 사용 가능</p>
      <p class="asset-facts muted">${icon('info')} ${publicationText(asset)}</p>` : `
      <p class="asset-facts">v${asset.version} · ${asset.width} × ${asset.height} · ${asset.format} · ${duration(asset.duration)}</p>
      <p class="asset-facts approved-fact">${icon('check-circle')} 내용 승인됨 · Instagram 일반 게시</p>
      <p class="asset-facts muted">${icon('clock')} 사용 기한 ${asset.rightsExpireDate}</p>
      <p class="asset-facts muted">${publicationText(asset)}</p>
      <div class="asset-actions">
        <button class="btn btn-primary" data-action="download" data-id="${asset.id}" data-version="${asset.versionId}" ${ready ? '' : 'disabled'}>${icon('download')} 게시용 파일 다운로드</button>
        <button class="btn btn-secondary" data-action="detail" data-id="${asset.id}">사용 조건·게시 기록</button>
      </div>`}
    </div></article>`;
}

function renderHome() {
  const pending = state.assets.filter((asset) => asset.approvalStatus === 'pending');
  const revised = state.assets.filter((asset) => asset.approvalStatus === 'revision_requested');
  const button = $('#home-review-button');
  if (button) {
    button.innerHTML = pending.length ? `${icon('play')} 영상 검토하기 ${icon('arrow-right')}` : revised.length ? `수정 요청 확인하기 ${icon('arrow-right')}` : `게시용 파일 보기 ${icon('arrow-right')}`;
  }
  const status = $('#home-project-status');
  if (status) status.textContent = pending.length ? `검토 대기 · v2${pending.length === 1 ? ' · 남은 1편' : ''}` : revised.length ? `수정 요청 전달 · ${revised.length}편` : '내용 승인 완료 · 2편';
  const list = $('#home-approved-list');
  if (list) list.innerHTML = state.assets.filter((asset) => ['terrace', 'morning', 'evening'].includes(asset.id) && canDownload(asset, currentOptions())).map((asset) => card(asset, true)).join('');
  const progress = $('#home-progress');
  if (progress) {
    progress.querySelectorAll('[data-step]').forEach((step) => {
      const stage = step.dataset.step;
      const isReady = pending.length === 0 && revised.length === 0;
      const isDone = ['capture', 'edit'].includes(stage) || (stage === 'review' && isReady);
      const isCurrent = isReady ? stage === 'ready' : stage === 'review';
      step.classList.toggle('is-complete', isDone);
      step.classList.toggle('is-done', isDone);
      step.classList.toggle('is-current', isCurrent);
      const stepImage = step.querySelector('img');
      if (stepImage) {
        stepImage.src = `assets/icons/${isDone ? 'check-circle' : isCurrent ? 'radio-button' : 'play-circle'}.svg`;
        stepImage.alt = isDone ? '완료' : isCurrent ? '현재 단계' : '다음 단계';
      }
      if ((isReady && stage === 'ready') || (!isReady && stage === 'review')) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }
}

function approvalOptions(asset) {
  return { ...currentOptions(), actorId: state.actorId, versionId: asset.versionId,
    confirmed: state.reviewConfirmed[asset.versionId] === true,
    feedback: state.feedbackDrafts[asset.versionId] || '' };
}

function reviewMedia(asset) {
  const webmSource = asset.source.replace(/\.mp4$/, '.webm');
  return `<div class="review-media">
    <div class="video-frame"><video controls playsinline preload="metadata" poster="${asset.image}" data-media-id="${asset.id}" aria-label="${escape(asset.title)} v${asset.version} 샘플 영상">
      <source src="${webmSource}" type="video/webm">
      <source src="${asset.source}" type="video/mp4">이 브라우저에서는 영상 재생을 지원하지 않습니다.</video></div>
    <p class="asset-facts muted">${icon('film-strip')} 세로 영상 · ${asset.width} × ${asset.height} · ${asset.duration}초 기획안</p>
    <p class="media-demo-note">가상 숙소 사진으로 만든 재생·다운로드 체험용 샘플입니다.</p>
    <div class="notice" data-media-error="${asset.id}" ${asset.previewAvailable === false ? '' : 'hidden'}>미리보기를 불러오지 못했습니다. <button class="text-link" data-action="reload-video" data-id="${asset.id}">다시 불러오기</button></div>
    <section class="review-copy"><h3 class="section-title">확인할 영상 문구</h3><ul>${asset.captions.map((caption) => `<li>${escape(caption)}</li>`).join('')}</ul><p class="muted">샘플 영상과 별도로, 실제 제작 시 사용할 문구 예시입니다.</p></section>
  </div>`;
}

function renderReview() {
  const root = $('#review-content');
  if (!root) return;
  const reviews = state.assets.filter((asset) => asset.id.startsWith('october-'));
  const asset = assetById(state.selectedReviewId) || reviews[0];
  const pending = asset.approvalStatus === 'pending';
  const feedback = state.feedbackDrafts[asset.versionId] || '';
  const permissionReason = rightsBlockReason(asset, currentOptions());
  root.innerHTML = `<div class="page-heading"><div><p class="eyebrow">REVIEW YOUR STORY</p><h1>영상의 마지막 한 끗을,<br>함께 확인해요.</h1><p class="muted">영상과 문구를 확인하고, 수정사항은 한 번에 남겨 주세요.</p></div><span class="tag">예시 데이터 · 10월 작업</span></div>
    <div class="tabs review-tabs" aria-label="검토할 영상">${reviews.map((item) => `<button class="${item.id === asset.id ? 'is-active' : ''}" data-action="select-review" data-id="${item.id}" aria-pressed="${item.id === asset.id}"><span>${escape(item.title)}</span><small>v${item.version} · ${labelStatus(item)}</small></button>`).join('')}</div>
    <div class="review-version-heading"><div><p class="eyebrow">VERSION 0${asset.version}</p><h2>${escape(asset.title)}</h2><p class="muted">전달 ${asset.deliveredDate} · 확인 기한 ${asset.dueDate}</p></div>${statusPill(asset)}</div>
    <div class="review-layout">${reviewMedia(asset)}<div class="review-inspector">
    <section class="inspector-section"><h3 class="section-title">이번 버전에서 달라졌어요</h3><p>${escape(asset.changeSummary || '변경 내용이 아직 등록되지 않았습니다.')}</p></section>
    <section class="inspector-section"><h3 class="section-title">사용 조건</h3><p class="approved-fact">${icon(permissionReason ? 'info' : 'check-circle')} ${permissionReason ? escape(permissionReason) : '이용허락 확인됨'}</p>
      <dl class="metadata-list"><div><dt>허용 채널</dt><dd>Instagram</dd></div><div><dt>사용 목적</dt><dd>자체 SNS 일반 게시</dd></div><div><dt>사용 기간</dt><dd>${asset.rightsStartDate} ~ ${asset.rightsExpireDate}</dd></div></dl><p class="muted">유료 광고·다른 채널·RAW/프로젝트 파일은 이 사용 범위에 포함되지 않아요.</p></section>
    ${pending ? `<section class="inspector-section"><h3 class="section-title">수정할 내용이 있나요?</h3><p class="muted">예시 주문에 포함된 문구·컷 순서 조정 1회. 추가 촬영은 범위 확인 후 안내해요.</p>
      <label class="field" for="review-feedback"><span>통합 수정사항</span><textarea id="review-feedback" rows="4" maxlength="3000" placeholder="예: 12초의 객실명을 ‘온유 1호’로 바꿔 주세요." data-version="${asset.versionId}">${escape(feedback)}</textarea></label>
      <p class="muted">작성 내용은 이 탭에서 유지되며 새로고침하면 초기화됩니다.</p>
      <p id="feedback-error" class="form-error" role="alert" hidden></p>
      <button class="btn btn-secondary" data-action="review-feedback" data-id="${asset.id}" data-version="${asset.versionId}">${icon('chat-circle')} 수정 요청 검토하기</button></section>
      <section class="approval-panel"><h3 class="section-title">이 버전으로 괜찮으신가요?</h3>
      <label class="check-field" for="review-confirm"><input type="checkbox" id="review-confirm" ${state.reviewConfirmed[asset.versionId] ? 'checked' : ''}><span><strong>${escape(asset.title)} v${asset.version}</strong>의 화면·문구·실제 시설·제공 서비스·노출 인물을 확인했습니다.</span></label>
      <p class="muted">내용 승인은 이 버전의 확인입니다. 게시 가능한 범위는 위 사용 조건을 따릅니다.</p>
      <button class="btn btn-primary" id="approve-version" data-action="approve" data-id="${asset.id}" data-version="${asset.versionId}" ${canApprove(asset, approvalOptions(asset)) ? '' : 'disabled'}>${icon('check')} v${asset.version} 이 버전 승인</button>
      <p id="approval-help" class="muted" aria-live="polite">${escape(approvalBlockReason(asset, approvalOptions(asset)))}</p></section>` : asset.approvalStatus === 'approved' ? `
      <section class="approval-panel"><p class="eyebrow">APPROVED VERSION</p><h3 class="section-title">v${asset.version} 내용 승인을 남겼어요.</h3><p>${escape(asset.approval.actor)} · ${displayDate(asset.approval.at)}</p><p class="muted">사용 조건과 게시 여부는 내용 승인과 별도로 확인합니다.</p><button class="btn btn-primary" data-action="open-library">게시용 보관함 보기 ${icon('arrow-right')}</button>${reviews.some((item) => item.approvalStatus === 'pending') ? `<button class="btn btn-secondary" data-action="next-review">다음 영상 검토하기</button>` : ''}</section>` : `
      <section class="approval-panel"><p class="eyebrow">REVISION REQUESTED</p><h3 class="section-title">v${asset.version} 수정 요청을 전달했어요.</h3><p class="feedback-saved">${escape(asset.revisionRequest?.text || '')}</p><p class="muted">${displayDate(asset.revisionRequest?.at)} · 이 버전은 승인되지 않았습니다. 제작자가 새 버전을 전달하면 다시 확인해 주세요.</p><button class="btn btn-secondary" data-action="next-review">다른 검토 영상 보기 ${icon('arrow-right')}</button></section>`}
    </div></div>`;
  bindMediaErrors(root);
}

function updateApprovalControl() {
  const asset = assetById(state.selectedReviewId);
  if (!asset || !$('#approve-version')) return;
  $('#approve-version').disabled = !canApprove(asset, approvalOptions(asset));
  $('#approval-help').textContent = approvalBlockReason(asset, approvalOptions(asset));
}

function libraryMatches() {
  const query = state.query.trim().toLocaleLowerCase('ko-KR');
  const available = state.assets.filter((asset) => canDownload(asset, currentOptions()));
  return { query, matches: available.filter((asset) => asset.title.toLocaleLowerCase('ko-KR').includes(query)) };
}

function libraryResultsMarkup(matches, query) {
  return matches.length ? `<div class="library-grid">${matches.map((asset) => card(asset)).join('')}</div>` : `<div class="empty-state">${icon('film-strip')}<h3>${query ? '검색 결과가 없어요.' : '현재 사용할 수 있는 파일이 없어요.'}</h3><p>${query ? '다른 단어로 검색하거나 검색어를 지워 주세요.' : '내용 승인·사용 조건·수납·보관 기간을 확인해 주세요.'}</p>${query ? '<button class="btn btn-secondary" data-action="clear-search">검색어 지우기</button>' : '<button class="btn btn-secondary" data-nav="review">검토함 보기</button>'}</div>`;
}

function renderLibraryResults() {
  const { query, matches } = libraryMatches();
  const results = $('#library-results');
  const count = $('#library-count');
  if (results) results.innerHTML = libraryResultsMarkup(matches, query);
  if (count) count.textContent = matches.length;
}

function renderLibrary() {
  const root = $('#library-content');
  if (!root) return;
  const { query, matches } = libraryMatches();
  const approved = state.assets.filter((asset) => asset.approvalStatus === 'approved');
  const blocked = approved.filter((asset) => !canDownload(asset, currentOptions()));
  root.innerHTML = `<div class="page-heading"><div><p class="eyebrow">READY FOR YOUR NEXT POST</p><h1>우리 숙소의 이야기,<br>꺼내 쓰기 좋게.</h1><p class="muted">사용 조건을 확인한 최신 승인본을 모았어요.</p></div><span class="tag">예시 데이터 · 게시용 보관함</span></div>
    <div class="filter-bar"><label class="field" for="library-channel"><span>게시할 채널</span><select id="library-channel"><option value="instagram">Instagram</option></select></label><label class="field" for="library-purpose"><span>사용 목적</span><select id="library-purpose"><option value="organic">자체 SNS 일반 게시</option></select></label><label class="field search-field" for="library-search"><span>콘텐츠 찾기</span><div class="search-input">${icon('magnifying-glass')}<input id="library-search" type="search" placeholder="콘텐츠 이름으로 검색" value="${escape(state.query)}" autocomplete="off"></div></label><button class="text-link" data-action="channel-inquiry">다른 채널 사용 문의 ${icon('arrow-right')}</button></div>
    <div class="library-list-heading"><h2 class="section-title">지금 게시할 수 있어요 <span id="library-count" class="muted">${matches.length}</span></h2><p class="muted">Instagram · 일반 게시 · 최신 승인 버전</p></div>
    <div id="library-results" aria-live="polite">${libraryResultsMarkup(matches, query)}</div>
    ${blocked.length ? `<section class="notice"><h2 class="section-title">현재 사용이 보류된 파일 ${blocked.length}개</h2>${blocked.map((asset) => `<p><strong>${escape(asset.title)} · v${asset.version}</strong><br>${escape(downloadBlockReason(asset, currentOptions()))}</p>`).join('')}<button class="text-link" data-action="channel-inquiry">제작 담당자에게 조건 확인 요청</button></section>` : ''}
    <div class="notice library-note">${icon('info')} <div><strong>다운로드한 뒤, Instagram에 직접 게시해 주세요.</strong><p>다운로드는 게시 완료가 아닙니다. 게시 여부는 각 파일의 ‘사용 조건·게시 기록’에서 남길 수 있어요. 파일은 동작 확인용 샘플이며, 상태는 새로고침하면 초기화됩니다.</p></div></div>`;
}

function render() { renderHome(); renderReview(); renderLibrary(); }

function showPage(page, { focus = true, updateHash = true } = {}) {
  if (!['home', 'review', 'content'].includes(page)) page = 'home';
  state.activePage = page;
  document.querySelectorAll('section[data-page]').forEach((section) => { section.hidden = section.dataset.page !== page; });
  document.querySelectorAll('#app-nav [data-nav]').forEach((button) => {
    const active = button.dataset.nav === page;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  document.title = `${{ home: '홈', review: '검토함', content: '콘텐츠' }[page]} · STAYCUT`;
  if (updateHash && location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
  if (focus) { $('#main-content')?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
}

function openModal(title, body, { wide = false } = {}) {
  modalReturnFocus = document.activeElement;
  const root = $('#dialog-root');
  root.innerHTML = `<div class="modal-backdrop"><section class="modal ${wide ? 'wide modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header class="dialog-head"><h2 id="dialog-title" tabindex="-1">${escape(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="닫기">${icon('x')}</button></header>${body}</section></div>`;
  document.body.classList.add('modal-open');
  $('#main-content')?.setAttribute('inert', '');
  $('#app-nav')?.setAttribute('inert', '');
  $('#dialog-title')?.focus();
  bindMediaErrors(root);
}

function closeModal() {
  const root = $('#dialog-root');
  root?.querySelectorAll('video').forEach((video) => video.pause());
  if (root) root.innerHTML = '';
  document.body.classList.remove('modal-open');
  $('#main-content')?.removeAttribute('inert');
  $('#app-nav')?.removeAttribute('inert');
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  else $('#main-content')?.focus({ preventScroll: true });
}

function modalError(message, field) {
  const element = $('#modal-error');
  if (element) { element.hidden = false; element.textContent = message; }
  if (field) { field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', 'modal-error'); field.focus(); }
}

function openPreview(asset) {
  openModal(`${asset.title} · v${asset.version}`, `${reviewMedia(asset)}<div class="form-actions"><button class="btn btn-secondary" data-action="close-modal">닫기</button><button class="btn btn-primary" data-action="detail" data-id="${asset.id}">사용 조건 보기 ${icon('arrow-right')}</button></div>`, { wide: true });
}

function openDetails(asset) {
  const reason = downloadBlockReason(asset, currentOptions());
  openModal('사용 조건과 게시 기록', `<p class="eyebrow">${escape(asset.title)} · v${asset.version}</p>
    <dl class="metadata-list"><div><dt>내용 승인</dt><dd>${escape(labelStatus(asset))}${asset.approval ? `<br>${escape(asset.approval.actor)} · ${displayDate(asset.approval.at)}` : ''}</dd></div><div><dt>이용허락</dt><dd>${escape(rightsBlockReason(asset, currentOptions()) || '확인됨')}</dd></div><div><dt>허용 채널·목적</dt><dd>Instagram · 자체 SNS 일반 게시</dd></div><div><dt>사용 기간</dt><dd>${asset.rightsStartDate} ~ ${asset.rightsExpireDate} (한국 시간 기준)</dd></div><div><dt>파일 보관 종료</dt><dd>${asset.accessExpireDate}</dd></div><div><dt>최종 전달 수납</dt><dd>${asset.finalDeliveryPaid ? '수납 확인됨' : '수납 확인 전'}</dd></div><div><dt>게시</dt><dd>${escape(publicationText(asset))}${asset.publicationResponses.length ? `<br>${asset.publicationResponses.map((record) => `${escape(CHANNELS[record.channel])} · ${record.status === 'published' ? `${escape(record.publishedDate)} · 운영자 자기신고${record.url ? ' · URL 입력됨(외부 확인 전)' : ''}` : '미게시'}<br>`).join('')}` : ''}</dd></div></dl>
    <p class="muted">이용허락은 위 채널·목적·기간에 한합니다. RAW·소스·프로젝트 파일 제공 권한은 포함하지 않습니다.</p>
    ${reason ? `<p class="notice">${escape(reason)}</p>` : `<button class="btn btn-primary" data-action="download" data-id="${asset.id}" data-version="${asset.versionId}">${icon('download')} v${asset.version} 샘플 파일 다운로드</button>`}
    <div class="form-actions"><button class="btn btn-secondary" data-action="publication" data-id="${asset.id}">게시 여부 남기기</button><button class="text-link" data-action="reuse" data-id="${asset.id}">이 원본으로 재편집 문의 ${icon('arrow-right')}</button></div>`);
}

function openPublication(asset) {
  const record = asset.publicationResponses.find((response) => response.channel === 'instagram');
  openModal('게시 여부 남기기', `<p class="eyebrow">예시 데이터 · ${escape(asset.title)} v${asset.version}</p><p class="muted">다운로드와 실제 게시는 별도입니다. 운영자가 알려 주신 응답으로 기록하며 외부 플랫폼에서 자동 확인하지 않습니다.</p>
    <form data-form="publication" data-id="${asset.id}" data-version="${asset.versionId}" novalidate>
    <fieldset class="field"><legend>게시 상태</legend><label class="radio-field"><input type="radio" name="publication-status" value="published" ${record?.status === 'published' ? 'checked' : ''}> 게시했어요</label><label class="radio-field"><input type="radio" name="publication-status" value="not_published" ${record?.status !== 'published' ? 'checked' : ''}> 아직 게시하지 않았어요</label></fieldset>
    <label class="field" for="publish-channel"><span>채널</span><select id="publish-channel" name="channel"><option value="instagram">Instagram</option></select></label>
    <div id="published-fields" ${record?.status === 'published' ? '' : 'hidden'}><label class="field" for="publish-date"><span>게시일 <span aria-hidden="true">*</span></span><input id="publish-date" type="date" name="date" value="${record?.publishedDate || DEMO_DATE}" max="${DEMO_DATE}"></label><label class="field" for="publish-url"><span>게시 URL <small>선택</small></span><input id="publish-url" type="url" name="url" placeholder="https://www.instagram.com/…" value="${escape(record?.url || '')}" maxlength="2000"></label></div>
    <div id="unpublished-fields" ${record?.status === 'published' ? 'hidden' : ''}><label class="field" for="publish-reason"><span>미게시 이유 <small>선택</small></span><select id="publish-reason" name="reason"><option value="">선택하지 않음</option value="schedule">게시 일정 조율 중</option><option value="quality">내용·품질 확인 중</option><option value="person">게시 담당자 확인 중</option><option value="format">규격 확인 중</option><option value="other">기타</option></select></label></div>
    <p id="modal-error" class="form-error" role="alert" hidden></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">취소</button><button class="btn btn-primary" type="submit">게시 응답 기록하기</button></div></form>`);
}

function openReuse(asset) {
  openModal('이 원본으로 재편집 문의', `<p class="eyebrow">예시 데이터 · ${escape(asset.title)} v${asset.version} 참고</p><p class="muted">가능 여부를 먼저 검토하는 요청입니다. 추가 제작·비용·일정·결제는 원본과 사용권 확인 후 별도로 합의합니다.</p>
    <form data-form="reuse" data-id="${asset.id}" data-version="${asset.versionId}" novalidate>
    <label class="field" for="reuse-topic"><span>원하는 주제 <span aria-hidden="true">*</span></span><input id="reuse-topic" name="topic" placeholder="예: 테라스에서 즐기는 느린 아침" maxlength="150" required></label>
    <label class="field" for="reuse-channel"><span>희망 채널</span><select id="reuse-channel" name="channel"><option value="instagram">Instagram</option><option value="youtube">YouTube Shorts · 사용 조건 추가 검토</option></select></label>
    <label class="field" for="reuse-date"><span>희망 기한 <span aria-hidden="true">*</span></span><input id="reuse-date" name="date" type="date" min="${DEMO_DATE}" required></label>
    <label class="field" for="reuse-changes"><span>새로 달라진 시설·서비스 <small>선택</small></span><textarea id="reuse-changes" name="changes" rows="3" maxlength="2000" placeholder="변경된 객실명이나 제공 서비스가 있다면 알려 주세요."></textarea></label>
    <p class="notice">참고 원본: ${escape(asset.title)} · ${asset.versionId}. 원본에 없는 장면은 추가 촬영 검토가 필요합니다.</p><p id="modal-error" class="form-error" role="alert" hidden></p>
    <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">취소</button><button class="btn btn-primary" type="submit">가능 여부 검토 요청</button></div></form>`);
}

function openChannelInquiry() {
  openModal('다른 채널 사용 문의', `<p class="eyebrow">예시 데이터 · 사용 범위 확인</p><p>현재 주문에는 Instagram 자체 SNS 일반 게시가 포함되어 있어요. 다른 채널·유료 광고는 이용허락과 견적을 먼저 확인합니다.</p><form data-form="inquiry" novalidate><label class="field" for="inquiry-channel"><span>원하는 채널·사용 목적</span><textarea id="inquiry-channel" name="request" rows="3" maxlength="1500" placeholder="예: YouTube Shorts에 일반 게시하고 싶어요." required></textarea></label><p id="modal-error" class="form-error" role="alert" hidden></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">취소</button><button class="btn btn-primary" type="submit">사용 조건 검토 요청</button></div></form>`);
}

function openFeedbackConfirmation(asset, versionId) {
  const text = (state.feedbackDrafts[asset.versionId] || '').trim();
  if (!text) { const error = $('#feedback-error'); error.textContent = '수정할 내용을 입력해 주세요. 전체 수정사항을 한 번에 보낼 수 있어요.'; error.hidden = false; $('#review-feedback').setAttribute('aria-invalid', 'true'); $('#review-feedback').focus(); return; }
  if (asset.versionId !== versionId || !asset.isLatest || asset.approvalStatus !== 'pending') { toast('검토 대상이 변경되었습니다. 현재 버전을 다시 확인해 주세요.'); return; }
  openModal('수정 요청을 확인해 주세요', `<p class="eyebrow">${escape(asset.title)} · v${asset.version}</p><p class="feedback-saved">${escape(text)}</p><p class="muted">제출하면 이 버전은 수정 요청 상태가 됩니다. 내용 승인은 남기지 않으며, 제작자가 새 버전을 전달하면 다시 확인해 주세요. 계약 범위를 넘는 요청은 비용·일정을 먼저 협의합니다.</p><p id="modal-error" class="form-error" role="alert" hidden></p><div class="form-actions"><button class="btn btn-secondary" data-action="close-modal">돌아가서 수정</button><button class="btn btn-primary" data-action="submit-feedback" data-id="${asset.id}" data-version="${asset.versionId}">수정 요청 보내기</button></div>`);
}

function approve(asset, expectedVersion) {
  const options = { ...approvalOptions(asset), versionId: expectedVersion };
  if (!canApprove(asset, options)) { toast(approvalBlockReason(asset, options)); return; }
  asset.approvalStatus = 'approved';
  asset.approval = { actor: '온유스테이 운영자', actorId: state.actorId, at: now(), versionId: expectedVersion };
  render();
  toast(`데모: ${asset.title} v${asset.version} 내용 승인을 기록했어요.`);
  $('#review-content h1')?.setAttribute('tabindex', '-1');
  $('#review-content h1')?.focus();
}

async function download(asset, versionId) {
  const options = { ...currentOptions(), versionId };
  if (!canDownload(asset, options)) { toast(downloadBlockReason(asset, options)); return; }
  try {
    // Fetch the real local sample so a missing file is never reported as delivered.
    const response = await fetch(asset.source);
    if (!response.ok || !(response.headers.get('content-type') || '').includes('video/')) throw new Error('media unavailable');
    const blob = await response.blob();
    if (!blob.size) throw new Error('empty media');
    // Check again after the asynchronous file read.
    if (!canDownload(asset, options)) { toast(downloadBlockReason(asset, options)); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `STAYCUT_${asset.title}_v${asset.version}_Instagram_샘플.mp4`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    asset.downloads.push({ at: now(), versionId, channel: state.channel, purpose: state.purpose });
    toast('샘플 파일 다운로드를 요청했어요. 실제 게시 여부는 별도로 남겨 주세요.');
  } catch {
    toast('샘플 파일을 내려받지 못했습니다. 네트워크와 파일을 확인한 뒤 다시 시도해 주세요.');
  }
}

function bindMediaErrors(root) {
  root.querySelectorAll('video').forEach((video) => {
    const sources = [...video.querySelectorAll('source')];
    const resetSourceFailures = () => sources.forEach((source) => { delete source.dataset.loadFailed; });
    const fail = () => {
      const asset = assetById(video.dataset.mediaId);
      if (asset) asset.previewAvailable = false;
      root.querySelectorAll(`[data-media-error="${video.dataset.mediaId}"]`).forEach((notice) => { notice.hidden = false; });
      updateApprovalControl();
    };
    video.addEventListener('error', fail);
    video.addEventListener('loadstart', resetSourceFailures);
    sources.forEach((source) => source.addEventListener('error', () => {
      source.dataset.loadFailed = 'true';
      if (sources.every((candidate) => candidate.dataset.loadFailed === 'true')) fail();
    }));
    video.addEventListener('loadedmetadata', () => { resetSourceFailures(); const asset = assetById(video.dataset.mediaId); if (asset) asset.previewAvailable = true; root.querySelectorAll(`[data-media-error="${video.dataset.mediaId}"]`).forEach((notice) => { notice.hidden = true; }); updateApprovalControl(); });
  });
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button, a');
  if (!button || button.disabled) return;
  const nav = button.dataset.nav;
  if (nav) { event.preventDefault(); render(); showPage(nav); return; }
  if (button.id === 'home-review-button') {
    const next = state.assets.find((asset) => asset.approvalStatus === 'pending') || state.assets.find((asset) => asset.approvalStatus === 'revision_requested');
    if (next) { state.selectedReviewId = next.id; renderReview(); showPage('review'); } else showPage('content'); return;
  }
  if (button.id === 'home-content-link') { event.preventDefault(); showPage('content'); return; }
  const action = button.dataset.action;
  const asset = assetById(button.dataset.id);
  switch (action) {
    case 'select-review': state.selectedReviewId = asset.id; renderReview(); $(`.review-tabs [data-id="${asset.id}"]`)?.focus(); break;
    case 'preview': openPreview(asset); break;
    case 'detail': openDetails(asset); break;
    case 'publication': openPublication(asset); break;
    case 'reuse': openReuse(asset); break;
    case 'channel-inquiry': openChannelInquiry(); break;
    case 'close-modal': closeModal(); break;
    case 'open-library': closeModal(); renderLibrary(); showPage('content'); break;
    case 'next-review': { const next = state.assets.find((item) => item.approvalStatus === 'pending' && item.id !== state.selectedReviewId) || state.assets.find((item) => item.id.startsWith('october-') && item.id !== state.selectedReviewId); if (next) state.selectedReviewId = next.id; renderReview(); showPage('review'); break; }
    case 'review-feedback': openFeedbackConfirmation(asset, button.dataset.version); break;
    case 'submit-feedback': {
      const text = (state.feedbackDrafts[asset.versionId] || '').trim();
      if (!text || !asset.isLatest || asset.versionId !== button.dataset.version || asset.approvalStatus !== 'pending' || accessBlockReason(asset)) { modalError('요청할 버전과 접근 권한을 다시 확인해 주세요.'); break; }
      const request = { id: `revision-${state.revisionRequests.length + 1}`, versionId: asset.versionId, text, at: now() };
      state.revisionRequests.push(request); asset.revisionRequest = request; asset.approvalStatus = 'revision_requested';
      closeModal(); render();
      $('#review-content .approval-panel h3')?.setAttribute('tabindex', '-1');
      $('#review-content .approval-panel h3')?.focus();
      toast('데모: 통합 수정 요청을 기록했어요. 새 버전이 도착하면 다시 확인해 주세요.'); break;
    }
    case 'approve': approve(asset, button.dataset.version); break;
    case 'download': download(asset, button.dataset.version); break;
    case 'clear-search': {
      state.query = '';
      const input = $('#library-search');
      if (input) input.value = '';
      renderLibraryResults();
      input?.focus();
      break;
    }
    case 'reload-video': document.querySelectorAll(`video[data-media-id="${asset.id}"]`).forEach((video) => {
      video.querySelectorAll('source').forEach((source) => { delete source.dataset.loadFailed; });
      video.load();
    }); toast('샘플 영상을 다시 불러옵니다.'); break;
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'review-feedback') {
    state.feedbackDrafts[event.target.dataset.version] = event.target.value;
    $('#feedback-error').hidden = true; event.target.removeAttribute('aria-invalid'); updateApprovalControl();
  }
  if (event.target.id === 'library-search') {
    state.query = event.target.value;
    if (!event.isComposing) renderLibraryResults();
  }
});

document.addEventListener('compositionend', (event) => {
  if (event.target.id === 'library-search') {
    state.query = event.target.value;
    renderLibraryResults();
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'review-confirm') { const asset = assetById(state.selectedReviewId); state.reviewConfirmed[asset.versionId] = event.target.checked; updateApprovalControl(); }
  if (event.target.id === 'library-channel') { state.channel = event.target.value; renderLibrary(); }
  if (event.target.id === 'library-purpose') { state.purpose = event.target.value; renderLibrary(); }
  if (event.target.name === 'publication-status') { const published = event.target.value === 'published'; $('#published-fields').hidden = !published; $('#unpublished-fields').hidden = published; }
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const asset = assetById(form.dataset.id);
  if (form.dataset.form === 'publication') {
    if (!asset || asset.approvalStatus !== 'approved' || asset.versionId !== form.dataset.version || accessBlockReason(asset)) { modalError('현재 파일 버전과 접근 권한을 다시 확인해 주세요.'); return; }
    const status = data.get('publication-status');
    const channel = data.get('channel');
    const date = data.get('date');
    const url = String(data.get('url') || '').trim();
    if (!['published', 'not_published'].includes(status) || !asset.channels.includes(channel)) { modalError('게시 상태와 채널을 확인해 주세요.'); return; }
    if (status === 'published' && (!validDate(date) || date > DEMO_DATE)) { modalError('예시 기준일(2026-10-15)까지의 올바른 게시일을 입력해 주세요.', $('#publish-date')); return; }
    if (status === 'published' && !validOptionalUrl(url)) { modalError('URL은 http:// 또는 https://로 시작해야 합니다. 입력하지 않아도 응답을 남길 수 있어요.', $('#publish-url')); return; }
    const response = { versionId: asset.versionId, channel, status, publishedDate: status === 'published' ? date : null, url: status === 'published' ? url : '', reason: status === 'not_published' ? data.get('reason') : '', at: now(), evidence: 'owner_reported' };
    asset.publicationResponses = asset.publicationResponses.filter((item) => item.channel !== channel).concat(response);
    closeModal(); renderHome(); renderLibrary(); toast('데모: 운영자 게시 응답을 기록했어요. 외부 플랫폼 확인 결과는 아닙니다.');
  } else if (form.dataset.form === 'reuse') {
    const topic = String(data.get('topic') || '').trim();
    const date = data.get('date');
    if (!topic) { modalError('원하는 주제를 입력해 주세요.', $('#reuse-topic')); return; }
    if (!validDate(date) || date < DEMO_DATE) { modalError('예시 기준일(2026-10-15) 이후의 희망 기한을 입력해 주세요.', $('#reuse-date')); return; }
    if (!asset || asset.versionId !== form.dataset.version || accessBlockReason(asset)) { modalError('참고할 원본의 접근 기간과 버전을 확인해 주세요.'); return; }
    state.reuseRequests.push({ versionId: asset.versionId, sourceId: asset.id, topic, dueDate: date, channel: data.get('channel'), changes: String(data.get('changes') || '').trim(), status: 'review_requested', at: now() });
    closeModal(); toast('데모: 재편집 가능 여부 검토 요청을 기록했어요. 제작이나 결제는 확정되지 않았습니다.');
  } else if (form.dataset.form === 'inquiry') {
    const request = String(data.get('request') || '').trim();
    if (!request) { modalError('원하는 채널과 사용 목적을 입력해 주세요.', $('#inquiry-channel')); return; }
    state.reuseRequests.push({ type: 'rights_inquiry', request, status: 'review_requested', at: now() });
    closeModal(); toast('데모: 사용 조건 검토 요청을 기록했어요. 이용허락이 변경된 것은 아닙니다.');
  }
});

document.addEventListener('keydown', (event) => {
  const modal = $('#dialog-root .modal');
  if (!modal) return;
  if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
  if (event.key === 'Tab') {
    const focusable = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), video[controls], a[href], [tabindex="0"]')].filter((element) => !element.closest('[hidden]'));
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement.id === 'dialog-title')) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
});

window.addEventListener('hashchange', () => showPage(location.hash.slice(1), { updateHash: false }));
render();
showPage(location.hash.slice(1) || 'home', { focus: false });
