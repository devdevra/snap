const PUBLIC_KEY = /^sb_publishable_[A-Za-z0-9_-]+$/;

export function readPublicConfig(env) {
  try {
    const url = new URL(env.SUPABASE_URL);
    const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || typeof publishableKey !== 'string'
      || publishableKey.length > 8192 || !PUBLIC_KEY.test(publishableKey)) return null;
    return { supabaseUrl: url.origin, publishableKey };
  } catch { return null; }
}

export function prepareJson(response) {
  response.setHeader('Cache-Control', 'no-store, private');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

export function createConfigHandler({ env = process.env } = {}) {
  return async function config(request, response) {
    prepareJson(response);
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.statusCode = 405;
      return response.end(JSON.stringify({ error: 'GET 요청만 지원합니다.' }));
    }
    const config = readPublicConfig(env);
    response.statusCode = config ? 200 : 503;
    response.end(JSON.stringify(config ?? { error: '서비스 연결 설정이 필요합니다.' }));
  };
}
