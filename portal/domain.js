// Prototype-only data. A production server must repeat every authorization check.
export const DEMO_DATE = '2026-10-15';
export const DEMO_APPROVER = 'onyu-owner';
export const CHANNELS = { instagram: 'Instagram', youtube: 'YouTube Shorts' };
export const PURPOSES = { organic: '자체 SNS 일반 게시', advertising: '유료 광고' };

const common = {
  kind: 'video', width: 1080, height: 1920, format: 'MP4',
  source: 'assets/demo-vertical.mp4', channels: ['instagram'], purposes: ['organic'],
  rightsStatus: 'valid', rightsStartDate: '2026-09-01', rightsExpireDate: '2027-10-15',
  accessStartDate: '2026-09-01', accessExpireDate: '2027-10-15',
  isLatest: true, accessAllowed: true, finalDeliveryPaid: true,
  approverId: DEMO_APPROVER, previewAvailable: true, publicationResponses: [], downloads: [],
};

export const fixtures = [
  { ...common, id: 'october-intro', versionId: 'october-intro-v2', version: 2,
    source: 'assets/intro-preview.mp4',
    title: '10월 숙소 소개 영상', duration: 28, image: 'assets/room-hero.png',
    approvalStatus: 'pending', deliveredDate: '2026-10-14', dueDate: '2026-10-18',
    changeSummary: '객실 소개 문구를 간결하게 정리하고, 테라스 장면의 순서를 조정했어요.',
    captions: ['온유스테이 · 오늘은 조금 천천히', '창밖 풍경과 함께하는 쉼', '우리만의 속도로 머무는 시간'],
  },
  { ...common, id: 'october-room', versionId: 'october-room-v2', version: 2,
    source: 'assets/room-preview.mp4',
    title: '객실에서 쉬는 하루', duration: 24, image: 'assets/morning.png',
    approvalStatus: 'pending', deliveredDate: '2026-10-14', dueDate: '2026-10-18',
    changeSummary: '객실명 표기를 수정하고, 침구와 창가 장면의 밝기를 조정했어요.',
    captions: ['아침 햇살이 머무는 객실', '온유스테이에서 쉬어 가는 하루', '시설과 제공 서비스는 예약 안내를 확인해 주세요'],
  },
  { ...common, id: 'terrace', versionId: 'terrace-v3', version: 3,
    source: 'assets/terrace-preview.mp4',
    title: '마음이 머무는 테라스', duration: 28, image: 'assets/terrace.png',
    approvalStatus: 'approved', approval: { actor: '온유스테이 운영자', versionId: 'terrace-v3', at: '2026-09-29T05:20:00Z' },
    deliveredDate: '2026-09-28', captions: ['마음이 머무는 테라스', '온유스테이에서 만나는 느린 하루'],
  },
  { ...common, id: 'morning', versionId: 'morning-v1', version: 1,
    source: 'assets/morning-preview.mp4',
    title: '아침이 다른 온유스테이', duration: 24, image: 'assets/morning.png',
    approvalStatus: 'approved', approval: { actor: '온유스테이 운영자', versionId: 'morning-v1', at: '2026-10-01T03:10:00Z' },
    deliveredDate: '2026-09-30', captions: ['아침이 다른 온유스테이', '창가에 내려앉은 햇살'],
  },
  { ...common, id: 'evening', versionId: 'evening-v1', version: 1,
    source: 'assets/evening-preview.mp4',
    title: '저녁 노을이 머무는 시간', duration: 25, image: 'assets/evening.png',
    approvalStatus: 'approved', approval: { actor: '온유스테이 운영자', versionId: 'evening-v1', at: '2026-10-02T07:00:00Z' },
    deliveredDate: '2026-10-01', captions: ['저녁 노을이 머무는 시간', '하루의 끝, 온유스테이'],
  },
];

export function createInitialState() {
  return {
    assets: JSON.parse(JSON.stringify(fixtures)), actorId: DEMO_APPROVER,
    activePage: 'home', selectedReviewId: 'october-intro',
    channel: 'instagram', purpose: 'organic', query: '', reviewFilter: 'all',
    feedbackDrafts: {}, reviewConfirmed: {}, revisionRequests: [], reuseRequests: [],
  };
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function inPeriod(date, start, end) {
  return isDate(date) && isDate(start) && isDate(end) && start <= date && date <= end;
}

export function rightsBlockReason(asset, { date = DEMO_DATE, channel = 'instagram', purpose = 'organic' } = {}) {
  if (!asset) return '파일을 찾을 수 없습니다.';
  if (asset.rightsStatus === 'expired' || (isDate(asset.rightsExpireDate) && date > asset.rightsExpireDate)) {
    return '사용 기간이 종료되어 최종 승인과 게시용 다운로드를 할 수 없습니다.';
  }
  if (asset.rightsStatus !== 'valid') return '사용 조건 확인 중 · 최종 승인 및 게시용 다운로드 불가';
  if (!inPeriod(date, asset.rightsStartDate, asset.rightsExpireDate)) return '현재 날짜는 계약상 사용 기간에 포함되지 않습니다.';
  if (!asset.channels?.includes(channel)) return '선택한 채널은 허용된 사용 범위에 포함되지 않습니다.';
  if (!asset.purposes?.includes(purpose)) return '선택한 목적은 허용된 사용 범위에 포함되지 않습니다.';
  return '';
}

export function accessBlockReason(asset, { date = DEMO_DATE } = {}) {
  if (!asset?.accessAllowed || !inPeriod(date, asset.accessStartDate, asset.accessExpireDate)) {
    return '계약상 파일 접근 기간이 종료되었거나 접근 권한이 없습니다.';
  }
  return '';
}

export function approvalBlockReason(asset, options = {}) {
  if (!asset) return '검토할 버전을 찾을 수 없습니다.';
  if (asset.approvalStatus === 'revision_requested') return '수정 요청을 보냈습니다. 새 버전이 도착하면 다시 검토해 주세요.';
  if (asset.approvalStatus === 'approved') return '이미 승인된 버전입니다.';
  if (asset.approvalStatus !== 'pending') return '현재 승인할 수 있는 검토 상태가 아닙니다.';
  if (!asset.isLatest || (options.versionId && options.versionId !== asset.versionId)) return '검토 대상이 변경되었습니다. 최신 버전을 확인해 주세요.';
  if ((options.actorId ?? DEMO_APPROVER) !== asset.approverId) return '이 작업의 승인 담당자만 승인할 수 있습니다.';
  const accessReason = accessBlockReason(asset, options);
  if (accessReason) return accessReason;
  const rightsReason = rightsBlockReason(asset, options);
  if (rightsReason) return rightsReason;
  if (asset.previewAvailable === false) return '미리보기를 불러오지 못했습니다. 영상을 다시 불러온 뒤 확인해 주세요.';
  if (options.feedback?.trim()) return '작성 중인 수정사항을 보내거나 비운 뒤 승인해 주세요.';
  if (!options.confirmed) return '영상과 아래 확인 내용을 확인한 뒤 체크해 주세요.';
  return '';
}

export function canApprove(asset, options = {}) {
  return approvalBlockReason(asset, options) === '';
}

export function downloadBlockReason(asset, options = {}) {
  if (!asset) return '파일을 찾을 수 없습니다.';
  if (asset.approvalStatus !== 'approved' || asset.approval?.versionId !== asset.versionId) return '정확한 버전의 내용 승인이 필요합니다.';
  if (!asset.isLatest || (options.versionId && options.versionId !== asset.versionId)) return '새 버전으로 대체된 파일입니다. 최신 승인본을 확인해 주세요.';
  const accessReason = accessBlockReason(asset, options);
  if (accessReason) return accessReason;
  const rightsReason = rightsBlockReason(asset, options);
  if (rightsReason) return rightsReason;
  if (asset.finalDeliveryPaid !== true) return '수납 확인 후 최종 파일을 전달합니다. 승인 이력은 유지됩니다.';
  if (!asset.source) return '게시용 파일을 준비 중입니다. 제작 담당자에게 확인해 주세요.';
  return '';
}

export function canDownload(asset, options = {}) {
  return downloadBlockReason(asset, options) === '';
}

export function validDate(value) { return isDate(value); }

export function validOptionalUrl(value) {
  if (!value.trim()) return true;
  try { return ['https:', 'http:'].includes(new URL(value.trim()).protocol); }
  catch { return false; }
}
