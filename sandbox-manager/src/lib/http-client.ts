export interface HttpOptions {
  headers?: Record<string, string>;
  connectTimeout?: number;
  readTimeout?: number;
  query?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  json: unknown;
  body: string;
}

async function request(
  method: string,
  url: string,
  body: unknown | undefined,
  opts: HttpOptions = {},
): Promise<HttpResponse> {
  const timeout = opts.readTimeout || opts.connectTimeout || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    let finalUrl = url;
    if (opts.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) finalUrl += (finalUrl.includes('?') ? '&' : '?') + qs;
    }

    const init: RequestInit = {
      method,
      headers: opts.headers,
      signal: controller.signal,
    };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(finalUrl, init);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, ok: res.ok, json, body: text };
  } finally {
    clearTimeout(timer);
  }
}

export function httpGet(url: string, opts?: HttpOptions): Promise<HttpResponse> {
  return request('GET', url, undefined, opts);
}

export function httpPost(url: string, body: unknown, opts?: HttpOptions): Promise<HttpResponse> {
  return request('POST', url, body, opts);
}

export function httpDelete(url: string, opts?: HttpOptions): Promise<HttpResponse> {
  return request('DELETE', url, undefined, opts);
}
