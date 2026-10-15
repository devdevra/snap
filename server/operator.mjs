import { createHash } from 'node:crypto';
import { prepareJson, readPublicConfig } from './public-config.mjs';

const BUCKET = 'staycut-deliverables';
const MAX_BODY_BYTES = 65536;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MIME_EXTENSIONS = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const TERM_KEYS = ['accessAllowed', 'accessStartDate', 'accessEndDate', 'rightsStatus',
  'rightsStartDate', 'rightsEndDate', 'allowedChannels', 'allowedPurposes', 'finalDeliveryPaid'];

class OperatorError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new OperatorError(status, code, message); };
const invalid = () => fail(400, 'VALIDATION', '입력 내용을 확인해 주세요.');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed, required = allowed) => record(value)
  && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function header(request, name) {
  const value = typeof request.headers?.get === 'function' ? request.headers.get(name)
    : request.headers?.[name.toLowerCase()];
  return typeof value === 'string' ? value : '';
}

function bearer(request) {
  const value = header(request, 'authorization');
  const match = value.length <= 8199 && /^Bearer (.+)$/i.exec(value);
  if (!match || !JWT.test(match[1])) fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
  return match[1];
}

async function bodyJson(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(header(request, 'content-type'))) {
    fail(415, 'VALIDATION', 'JSON 형식으로 요청해 주세요.');
  }
  const length = header(request, 'content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    fail(413, 'VALIDATION', '요청이 너무 큽니다. 영상 파일은 저장소로 직접 업로드해 주세요.');
  }
  let body = request.body;
  try {
    if (body === undefined && request[Symbol.asyncIterator]) {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES) fail(413, 'VALIDATION', '요청이 너무 큽니다.');
        chunks.push(buffer);
      }
      body = Buffer.concat(chunks).toString('utf8');
    }
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) body = Buffer.from(body).toString('utf8');
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) fail(413, 'VALIDATION', '요청이 너무 큽니다.');
      body = JSON.parse(body);
    } else if (Buffer.byteLength(JSON.stringify(body) ?? '') > MAX_BODY_BYTES) {
      fail(413, 'VALIDATION', '요청이 너무 큽니다.');
    }
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    invalid();
  }
  if (!record(body)) invalid();
  return body;
}

function validTerms(terms) {
  if (!exactKeys(terms, TERM_KEYS) || typeof terms.accessAllowed !== 'boolean'
    || typeof terms.finalDeliveryPaid !== 'boolean'
    || !['pending', 'valid', 'expired'].includes(terms.rightsStatus)) return false;
  if (![terms.accessStartDate, terms.accessEndDate, terms.rightsStartDate, terms.rightsEndDate].every(date)
    || terms.accessStartDate > terms.accessEndDate || terms.rightsStartDate > terms.rightsEndDate) return false;
  return [[terms.allowedChannels, ['instagram', 'youtube']], [terms.allowedPurposes, ['organic', 'advertising']]]
    .every(([values, allowed]) => Array.isArray(values) && values.length <= allowed.length
      && new Set(values).size === values.length && values.every(value => allowed.includes(value)));
}

function validFile(file) {
  return exactKeys(file, ['sha256', 'bytes', 'mimeType']) && typeof file.sha256 === 'string'
    && SHA256.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 12
    && file.bytes <= MAX_FILE_BYTES && typeof file.mimeType === 'string' && Object.hasOwn(MIME_EXTENSIONS, file.mimeType);
}

function validateInput(input) {
  switch (input.action) {
    case 'context':
      if (!exactKeys(input, ['action'])) invalid();
      return input;
    case 'createTenant':
      if (!exactKeys(input, ['action', 'name', 'customerEmail', 'accessStartDate', 'accessEndDate'])
        || !text(input.name, 120) || typeof input.customerEmail !== 'string'
        || input.customerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.customerEmail)
        || !date(input.accessStartDate) || !date(input.accessEndDate)
        || input.accessStartDate > input.accessEndDate) invalid();
      return { ...input, name: input.name.trim(), customerEmail: input.customerEmail.toLowerCase() };
    case 'prepareUpload': {
      if (!exactKeys(input, ['action', 'tenantId', 'assetId', 'title', 'assignedApproverId', 'changeSummary', 'terms', 'delivery', 'preview', 'expectedRevisionId', 'expectedLatestVersionId'],
        ['action', 'tenantId', 'changeSummary', 'delivery', 'preview'])
        || !uuid(input.tenantId) || typeof input.changeSummary !== 'string' || input.changeSummary.length > 2000
        || !validFile(input.delivery) || !validFile(input.preview) || input.delivery.sha256 === input.preview.sha256) invalid();
      if (input.assetId !== null && input.assetId !== undefined) {
        if (!uuid(input.assetId) || ['title', 'assignedApproverId', 'terms'].some(key => Object.hasOwn(input, key))
          || !Object.hasOwn(input, 'expectedRevisionId')
          || (input.expectedRevisionId !== null && !uuid(input.expectedRevisionId))
          || !Object.hasOwn(input, 'expectedLatestVersionId')
          || (input.expectedLatestVersionId !== null && !uuid(input.expectedLatestVersionId))) invalid();
      } else if (!text(input.title, 200) || !uuid(input.assignedApproverId) || !validTerms(input.terms)
        || Object.hasOwn(input, 'expectedRevisionId') || Object.hasOwn(input, 'expectedLatestVersionId')) invalid();
      return { ...input, assetId: input.assetId ?? null };
    }
    case 'commitUpload':
      if (!exactKeys(input, ['action', 'sessionId']) || !uuid(input.sessionId)) invalid();
      return input;
    case 'updateAsset':
      if (!exactKeys(input, ['action', 'assetId', 'terms']) || !uuid(input.assetId) || !validTerms(input.terms)) invalid();
      return input;
    default: invalid();
  }
}

function signingHeaders(env) {
  const safe = value => typeof value === 'string' && value.length > 0 && value.length <= 8192
    && !/[\s\x00-\x1f\x7f]/.test(value);
  if (env.SUPABASE_SECRET_KEY !== undefined && env.SUPABASE_SECRET_KEY !== '') {
    if (!safe(env.SUPABASE_SECRET_KEY) || !/^sb_secret_[A-Za-z0-9_-]+$/.test(env.SUPABASE_SECRET_KEY)) {
      fail(503, 'CONFIG_REQUIRED', '업로드 서버 설정을 확인해 주세요.');
    }
    return { apikey: env.SUPABASE_SECRET_KEY };
  }
  if (safe(env.SUPABASE_SERVICE_ROLE_KEY) && JWT.test(env.SUPABASE_SERVICE_ROLE_KEY)) {
    return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  }
  fail(503, 'CONFIG_REQUIRED', '업로드 서버 설정이 필요합니다.');
}

async function* responseChunks(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return;
  let finished = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('aborted');
      const chunk = await reader.read();
      if (signal.aborted) throw new Error('aborted');
      if (chunk.done) { finished = true; return; }
      yield chunk.value;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function limitedJson(response, signal) {
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of responseChunks(response, signal)) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 256 * 1024) fail(502, 'UPSTREAM', '서버 응답을 확인할 수 없습니다.');
      chunks.push(buffer);
    }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function transport(fetchImpl, { timeoutMs, streamTimeoutMs, deadline, now }) {
  async function timed(url, options, duration, consume) {
    const remaining = deadline - now();
    if (remaining <= 0) fail(504, 'TIMEOUT', '처리 시간이 초과되었습니다. 같은 요청을 다시 시도해 주세요.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(duration, remaining));
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
      return await consume(response, controller.signal);
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      if (controller.signal.aborted) fail(504, 'TIMEOUT', '처리 시간이 초과되었습니다. 같은 요청을 다시 시도해 주세요.');
      fail(502, 'UPSTREAM', '저장 서비스에 연결할 수 없습니다. 같은 요청을 다시 시도해 주세요.');
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  return {
    json: (url, options) => timed(url, options, timeoutMs, async (response, signal) => ({
      ok: response.ok, status: response.status, data: await limitedJson(response, signal),
    })),
    file: (url, headers, expected) => timed(url, { method: 'GET', headers }, streamTimeoutMs, async (response, signal) => {
      if (!response.ok) {
        if (response.status === 404) return null;
        const error = await limitedJson(response, signal);
        if (String(error?.statusCode) === '404') return null;
        fail(502, 'UPSTREAM', '업로드 파일을 확인할 수 없습니다.');
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      const declared = response.headers.get('content-length');
      if (type !== expected.mimeType || (declared !== null && (!/^\d+$/.test(declared)
        || Number(declared) !== expected.bytes || Number(declared) > MAX_FILE_BYTES))) {
        fail(409, 'FILE_MISMATCH', '업로드된 파일 형식이나 크기가 일치하지 않습니다.');
      }
      if (!response.body) fail(409, 'FILE_MISMATCH', '업로드된 파일을 확인할 수 없습니다.');
      const hash = createHash('sha256');
      const head = Buffer.alloc(4096);
      let headLength = 0;
      let bytes = 0;
      for await (const chunk of responseChunks(response, signal)) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_FILE_BYTES || bytes > expected.bytes) fail(409, 'FILE_MISMATCH', '업로드된 파일 크기가 일치하지 않습니다.');
        hash.update(buffer);
        const copied = Math.min(buffer.length, head.length - headLength);
        if (copied > 0) { buffer.copy(head, headLength, 0, copied); headLength += copied; }
      }
      const signature = head.subarray(0, headLength);
      const mimeMatches = expected.mimeType === 'video/mp4'
        ? signature.length >= 12 && signature.toString('ascii', 4, 8) === 'ftyp'
        : signature.length >= 12 && signature.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
          && signature.includes(Buffer.from('webm'));
      const sha256 = hash.digest('hex');
      if (!mimeMatches || bytes !== expected.bytes || sha256 !== expected.sha256) {
        fail(409, 'FILE_MISMATCH', '업로드된 파일 내용이 일치하지 않습니다. 새로 업로드해 주세요.');
      }
      return { sha256, bytes };
    }),
  };
}

function rpcError(result) {
  if (result.status === 401) fail(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
  if (result.status === 403 || result.data?.code === '42501') fail(403, 'OPERATOR_REQUIRED', '운영자 권한이 필요합니다.');
  if (result.data?.code === '22023') invalid();
  if (['55000', '23505', '23503', '40001'].includes(result.data?.code)) {
    fail(409, 'UPLOAD_CONFLICT', '현재 상태와 요청이 일치하지 않습니다. 목록을 새로 불러와 확인해 주세요.');
  }
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(result.data?.code)) {
    fail(503, 'CONFIG_REQUIRED', '운영자 데이터베이스 설정이 필요합니다.');
  }
  fail(502, 'UPSTREAM', '운영자 요청을 처리할 수 없습니다.');
}

function checkedManifest(value, { sessionId, actorId, now }) {
  if (!record(value) || ![value.sessionId, value.tenantId, value.assetId, value.versionId].every(uuid)
    || (sessionId && value.sessionId !== sessionId) || !['prepared', 'committed'].includes(value.status)
    || (value.createdBy !== undefined && value.createdBy !== actorId)) {
    fail(502, 'UPSTREAM', '업로드 예약 정보를 확인할 수 없습니다.');
  }
  if (value.status === 'committed') return value;
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= now()) fail(409, 'UPLOAD_CONFLICT', '업로드 예약이 만료되었습니다. 다시 업로드해 주세요.');
  for (const kind of ['delivery', 'preview']) {
    const file = value[kind];
    if (!record(file) || !validFile({ sha256: file.sha256, bytes: file.bytes, mimeType: file.mimeType })) {
      fail(502, 'UPSTREAM', '업로드 파일 정보를 확인할 수 없습니다.');
    }
    const ext = MIME_EXTENSIONS[file.mimeType];
    const final = `${value.tenantId}/${value.assetId}/${value.versionId}/${kind === 'preview' ? 'preview/review' : 'delivery'}.${ext}`;
    if (file.stagingPath !== `staging/${value.sessionId}/${kind}.${ext}` || file.finalPath !== final) {
      fail(502, 'UPSTREAM', '업로드 파일 경로를 확인할 수 없습니다.');
    }
  }
  if (value.delivery.sha256 === value.preview.sha256 || value.delivery.finalPath === value.preview.finalPath) {
    fail(409, 'FILE_MISMATCH', '납품 원본과 검토용 파일은 서로 다른 파일이어야 합니다.');
  }
  return value;
}

function ids(manifest) {
  return { sessionId: manifest.sessionId, tenantId: manifest.tenantId, assetId: manifest.assetId,
    versionId: manifest.versionId, status: manifest.status };
}

function signedUploadUrl(origin, payload, path) {
  const raw = payload?.url;
  const expected = `/storage/v1/object/upload/sign/${BUCKET}/${path}`;
  try {
    if (typeof raw !== 'string' || raw.length > 16384 || /[\\\x00-\x20\x7f]/.test(raw)) throw new Error();
    const absolute = raw.startsWith('/object/upload/sign/') ? `${origin}/storage/v1${raw}` : raw;
    const url = new URL(absolute, origin);
    const token = url.searchParams.get('token');
    if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.hash
      || url.pathname !== expected || !token || token.length > 8192 || !/^[A-Za-z0-9_.-]+$/.test(token)
      || [...url.searchParams.keys()].length !== 1) throw new Error();
    return { url: url.href, token };
  } catch { fail(502, 'UPSTREAM', '업로드 주소를 만들 수 없습니다.'); }
}

function safeContext(value, actorId) {
  if (!record(value) || !record(value.operator) || value.operator.user_id !== actorId
    || !['tenants', 'members', 'assets'].every(key => Array.isArray(value[key]))) {
    fail(403, 'OPERATOR_REQUIRED', '운영자 권한이 필요합니다.');
  }
  return { operator: { user_id: actorId }, tenants: value.tenants, members: value.members, assets: value.assets };
}

/** Only metadata traverses this route; browser video uploads go directly to Storage. */
export function createOperatorHandler({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 8000,
  streamTimeoutMs = 60000, totalTimeoutMs = 150000, now = () => Date.now() } = {}) {
  return async function operator(request, response) {
    prepareJson(response);
    response.setHeader('Vary', 'Authorization');
    let status = 200;
    let result;
    try {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        fail(405, 'VALIDATION', 'POST 요청만 지원합니다.');
      }
      const token = bearer(request);
      const input = validateInput(await bodyJson(request));
      const config = readPublicConfig(env);
      if (!config) fail(503, 'CONFIG_REQUIRED', '운영자 서버 설정이 필요합니다.');
      const network = transport(fetchImpl, { timeoutMs, streamTimeoutMs, deadline: now() + totalTimeoutMs, now });
      const userHeaders = { apikey: config.publishableKey, Authorization: `Bearer ${token}` };
      const auth = await network.json(`${config.supabaseUrl}/auth/v1/user`, { method: 'GET', headers: userHeaders });
      if (auth.status === 401 || auth.status === 403) fail(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      if (!auth.ok || !uuid(auth.data?.id)) fail(502, 'UPSTREAM', '로그인 정보를 확인할 수 없습니다.');
      const actorId = auth.data.id;
      const rpc = async (name, data, headers = userHeaders) => {
        const reply = await network.json(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        });
        if (!reply.ok) rpcError(reply);
        return reply.data;
      };
      const context = safeContext(await rpc('operator_context', {}), actorId);
      switch (input.action) {
        case 'context': result = context; break;
        case 'createTenant':
          result = await rpc('operator_create_tenant', { p_name: input.name, p_customer_email: input.customerEmail,
            p_access_start_date: input.accessStartDate, p_access_end_date: input.accessEndDate });
          if (!record(result)) fail(502, 'UPSTREAM', '고객사 저장 결과를 확인할 수 없습니다.');
          break;
        case 'updateAsset': {
          const { action, ...payload } = input;
          result = await rpc('operator_update_asset', { p_input: payload });
          if (!record(result)) fail(502, 'UPSTREAM', '콘텐츠 저장 결과를 확인할 수 없습니다.');
          break;
        }
        case 'prepareUpload': {
          const headers = signingHeaders(env);
          const { action, ...payload } = input;
          const manifest = checkedManifest(await rpc('operator_prepare_upload', { p_input: payload }), { actorId, now });
          if (manifest.status !== 'prepared' || manifest.tenantId !== input.tenantId
            || (input.assetId && manifest.assetId !== input.assetId)) fail(502, 'UPSTREAM', '업로드 예약 정보를 확인할 수 없습니다.');
          result = { ...ids(manifest), expiresAt: manifest.expiresAt };
          for (const kind of ['delivery', 'preview']) {
            const file = manifest[kind];
            if (file.sha256 !== input[kind].sha256 || file.bytes !== input[kind].bytes || file.mimeType !== input[kind].mimeType) {
              fail(502, 'UPSTREAM', '업로드 예약 파일 정보가 일치하지 않습니다.');
            }
          }
          for (const kind of ['delivery', 'preview']) {
            const file = manifest[kind];
            const signed = await network.json(`${config.supabaseUrl}/storage/v1/object/upload/sign/${BUCKET}/${file.stagingPath}`, {
              method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-upsert': 'false' }, body: '{}',
            });
            if (!signed.ok) fail(502, 'UPSTREAM', '업로드 주소를 만들 수 없습니다.');
            result[kind] = { ...signedUploadUrl(config.supabaseUrl, signed.data, file.stagingPath),
              bytes: file.bytes, mimeType: file.mimeType };
          }
          break;
        }
        case 'commitUpload': {
          const manifest = checkedManifest(await rpc('operator_upload_manifest', { p_session_id: input.sessionId }),
            { sessionId: input.sessionId, actorId, now });
          if (manifest.status === 'committed') { result = ids(manifest); break; }
          const headers = signingHeaders(env);
          const verified = {};
          for (const kind of ['delivery', 'preview']) {
            const file = manifest[kind];
            const fileUrl = path => `${config.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`;
            let actual = await network.file(fileUrl(file.finalPath), headers, file);
            if (!actual) {
              const staging = await network.file(fileUrl(file.stagingPath), headers, file);
              if (!staging) fail(409, 'UPLOAD_CONFLICT', '파일 업로드가 완료되지 않았습니다. 두 파일을 업로드해 주세요.');
              // Storage MOVE refuses existing destinations. Re-read final even
              // after uncertain move responses: another retry may have promoted
              // it. Never overwrite or delete a possibly committed final object.
              try {
                await network.json(`${config.supabaseUrl}/storage/v1/object/move`, {
                  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bucketId: BUCKET, sourceKey: file.stagingPath, destinationKey: file.finalPath }),
                });
              } catch (error) { if (!(error instanceof OperatorError)) throw error; }
              actual = await network.file(fileUrl(file.finalPath), headers, file);
              if (!actual) fail(409, 'UPLOAD_CONFLICT', '파일 이동이 완료되지 않았습니다. 같은 요청을 다시 시도해 주세요.');
            }
            verified[kind] = actual;
          }
          if (verified.delivery.sha256 === verified.preview.sha256) fail(409, 'FILE_MISMATCH', '원본과 검토용 파일이 같을 수 없습니다.');
          const committed = await rpc('operator_commit_upload', { p_session_id: manifest.sessionId, p_actor_id: actorId,
            p_delivery_sha256: verified.delivery.sha256, p_delivery_bytes: verified.delivery.bytes,
            p_preview_sha256: verified.preview.sha256, p_preview_bytes: verified.preview.bytes }, headers);
          if (!record(committed) || committed.status !== 'committed'
            || ['sessionId', 'tenantId', 'assetId', 'versionId'].some(key => committed[key] !== manifest[key])) {
            fail(502, 'UPSTREAM', '저장 결과를 확인할 수 없습니다. 같은 요청을 다시 시도해 주세요.');
          }
          result = ids(committed);
          break;
        }
      }
    } catch (error) {
      status = error instanceof OperatorError ? error.status : 500;
      result = { error: error instanceof OperatorError ? error.message : '운영자 요청을 처리할 수 없습니다.',
        code: error instanceof OperatorError ? error.code : 'INTERNAL' };
    }
    response.statusCode = status;
    response.end(JSON.stringify(result));
  };
}
