const BUCKET = 'staycut-deliverables';
const LINK_TTL_SECONDS = 60;
const MAX_BODY_BYTES = 2048;
const MAX_TOKEN_LENGTH = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

class DownloadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => { throw new DownloadError(status, message); };

function header(request, name) {
  const value = typeof request.headers?.get === 'function'
    ? request.headers.get(name)
    : request.headers?.[name.toLowerCase()];
  return typeof value === 'string' ? value : '';
}

function readConfig(env) {
  const url = env.SUPABASE_URL;
  const publicKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  const secretKey = env.SUPABASE_SECRET_KEY;
  const legacyKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const safeKey = value => typeof value === 'string' && value.length <= MAX_TOKEN_LENGTH
    && value.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value);
  let origin;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
    origin = parsed.origin;
  } catch {
    fail(503, '다운로드 서버 설정이 필요합니다.');
  }
  if (!safeKey(publicKey) || (!publicKey.startsWith('sb_publishable_') && !JWT.test(publicKey))) {
    fail(503, '다운로드 서버 설정이 필요합니다.');
  }
  let signingHeaders;
  if (secretKey) {
    if (!safeKey(secretKey) || !secretKey.startsWith('sb_secret_')) {
      fail(503, '다운로드 서버 설정이 필요합니다.');
    }
    // New Supabase secret keys are API keys, not JWT bearer tokens.
    signingHeaders = { apikey: secretKey };
  } else if (safeKey(legacyKey) && JWT.test(legacyKey)) {
    signingHeaders = { apikey: legacyKey, Authorization: `Bearer ${legacyKey}` };
  } else {
    fail(503, '다운로드 서버 설정이 필요합니다.');
  }
  return { origin, publicKey, signingHeaders };
}

function readToken(request) {
  const authorization = header(request, 'authorization');
  if (authorization.length > MAX_TOKEN_LENGTH + 7) fail(401, '로그인이 필요합니다.');
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(authorization);
  if (!match || !JWT.test(match[1])) fail(401, '로그인이 필요합니다.');
  return match[1];
}

async function readBody(request, mode) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(header(request, 'content-type'))) {
    fail(415, 'JSON 형식으로 요청해 주세요.');
  }
  const declaredLength = header(request, 'content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength)
    || Number(declaredLength) > MAX_BODY_BYTES)) fail(413, '요청이 너무 큽니다.');

  let body = request.body;
  if (body === undefined && request[Symbol.asyncIterator]) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) fail(413, '요청이 너무 큽니다.');
      chunks.push(buffer);
    }
    body = Buffer.concat(chunks);
  }
  try {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) body = Buffer.from(body).toString('utf8');
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) fail(413, '요청이 너무 큽니다.');
      body = JSON.parse(body);
    } else if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
      fail(413, '요청이 너무 큽니다.');
    }
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    fail(400, '요청 내용을 확인해 주세요.');
  }
  const keys = mode === 'preview' ? ['versionId'] : ['versionId', 'channel', 'purpose'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== keys.length
    || Object.keys(body).some(key => !keys.includes(key))
    || typeof body.versionId !== 'string' || !UUID.test(body.versionId)
    || (mode === 'download' && (!['instagram', 'youtube'].includes(body.channel)
      || !['organic', 'advertising'].includes(body.purpose)))) {
    fail(400, '요청 내용을 확인해 주세요.');
  }
  return body;
}

async function requestJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 65536) fail(502, '다운로드 서비스를 확인할 수 없습니다.');
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    return { status: response.status, ok: response.ok, data };
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (controller.signal.aborted) fail(504, '다운로드 요청 시간이 초과되었습니다. 다시 시도해 주세요.');
    fail(502, '다운로드 서비스에 연결할 수 없습니다.');
  } finally {
    clearTimeout(timeout);
  }
}

function encodeObjectPath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024
    || /[\\%?#\x00-\x20\x7f]/.test(path)) {
    fail(502, '다운로드 파일 정보를 확인할 수 없습니다.');
  }
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    fail(502, '다운로드 파일 정보를 확인할 수 없습니다.');
  }
  return segments.map(encodeURIComponent).join('/');
}

function checkedSignedUrl(origin, payload, encodedPath) {
  const raw = payload?.signedURL ?? payload?.signedUrl;
  const expectedPath = `/storage/v1/object/sign/${BUCKET}/${encodedPath}`;
  let signed;
  try {
    if (typeof raw !== 'string' || raw.length > 16384 || /[\\\x00-\x20\x7f]/.test(raw)) throw new Error();
    const absolute = raw.startsWith('/object/sign/') ? `${origin}/storage/v1${raw}` : raw;
    signed = new URL(absolute, origin);
    if (signed.origin !== origin || signed.protocol !== 'https:' || signed.username || signed.password
      || signed.pathname !== expectedPath || signed.hash || !signed.searchParams.get('token')) throw new Error();
  } catch {
    fail(502, '다운로드 링크를 만들 수 없습니다.');
  }
  return signed.href;
}

/** Both routes retain end-user identity until the exact object is authorized. */
function createPrivateLinkHandler(mode, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  return async function download(request, response) {
    response.setHeader('Cache-Control', 'no-store, private');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Vary', 'Authorization');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    let status = 200;
    let body;
    try {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        fail(405, 'POST 요청만 지원합니다.');
      }
      const token = readToken(request);
      const input = await readBody(request, mode);
      const config = readConfig(env);
      const userHeaders = { apikey: config.publicKey, Authorization: `Bearer ${token}` };
      const auth = await requestJson(fetchImpl, `${config.origin}/auth/v1/user`, {
        method: 'GET', headers: userHeaders,
      }, timeoutMs);
      if (auth.status === 401 || auth.status === 403) fail(401, '다시 로그인해 주세요.');
      if (!auth.ok || !UUID.test(auth.data?.id ?? '')) fail(502, '로그인 정보를 확인할 수 없습니다.');

      const rpcBody = mode === 'preview' ? { p_version_id: input.versionId }
        : { p_version_id: input.versionId, p_channel: input.channel, p_purpose: input.purpose };
      const authorization = await requestJson(fetchImpl, `${config.origin}/rest/v1/rpc/authorize_asset_${mode}`, {
        method: 'POST',
        headers: { ...userHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcBody),
      }, timeoutMs);
      if (!authorization.ok) {
        if (authorization.status === 401) fail(401, '다시 로그인해 주세요.');
        if (authorization.data?.code === '55000') {
          fail(409, mode === 'preview' ? '최신 버전의 미리보기 준비 상태를 확인해 주세요.'
            : '승인·결제·이용 권한을 확인해 주세요.');
        }
        if (authorization.status === 403 || authorization.data?.code === '42501') {
          fail(403, '이 파일을 다운로드할 권한이 없습니다.');
        }
        if (authorization.data?.code === '22023') fail(400, '요청 내용을 확인해 주세요.');
        fail(502, '다운로드 권한을 확인할 수 없습니다.');
      }
      if (!Array.isArray(authorization.data) || authorization.data.length !== 1) {
        fail(403, '이 파일을 다운로드할 권한이 없습니다.');
      }
      const asset = authorization.data[0];
      if (asset?.bucket_id !== BUCKET) fail(502, '다운로드 파일 정보를 확인할 수 없습니다.');
      const encodedPath = encodeObjectPath(asset.object_path);
      if (mode === 'preview') {
        const parts = asset.object_path.split('/');
        if (parts.length < 5 || !UUID.test(parts[0]) || !UUID.test(parts[1])
          || parts[2].toLowerCase() !== input.versionId.toLowerCase() || parts[3] !== 'preview') {
          fail(502, '미리보기 파일 정보를 확인할 수 없습니다.');
        }
      }
      const signed = await requestJson(fetchImpl, `${config.origin}/storage/v1/object/sign/${BUCKET}/${encodedPath}`, {
        method: 'POST',
        headers: { ...config.signingHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: LINK_TTL_SECONDS }),
      }, timeoutMs);
      if (!signed.ok) fail(502, '다운로드 링크를 만들 수 없습니다.');
      const signedUrl = new URL(checkedSignedUrl(config.origin, signed.data, encodedPath));
      if (mode === 'download') {
        const filename = asset.object_path.split('/').at(-1)
          .replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 180) || 'delivery.mp4';
        // Storage applies Content-Disposition for this parameter; cross-origin
        // anchors cannot reliably force downloads with the HTML download attribute.
        signedUrl.searchParams.set('download', filename);
      }
      body = { url: signedUrl.href, expiresIn: LINK_TTL_SECONDS };
    } catch (error) {
      status = error instanceof DownloadError ? error.status : 500;
      const message = error instanceof DownloadError ? error.message : '다운로드 요청을 처리할 수 없습니다.';
      body = { error: mode === 'preview' ? message.replaceAll('다운로드', '미리보기') : message };
    }
    response.statusCode = status;
    response.end(JSON.stringify(body));
  };
}

/** Injectable transport keeps authorization and signing tests entirely offline. */
export function createDownloadHandler(options) { return createPrivateLinkHandler('download', options); }
export function createPreviewHandler(options) { return createPrivateLinkHandler('preview', options); }
