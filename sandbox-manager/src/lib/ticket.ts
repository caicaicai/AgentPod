import crypto from 'crypto';
import { envStr, envInt } from '../config';

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer | null {
  let str = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4;
  if (pad === 2) str += '==';
  else if (pad === 3) str += '=';
  else if (pad === 1) return null;
  try {
    return Buffer.from(str, 'base64');
  } catch {
    return null;
  }
}

function secret(): string {
  return envStr('SANDBOX_TICKET_SECRET');
}

export interface TicketPayload {
  nid: string;
  run: string;
  username: string;
  exp: number;
  jti: string;
  scp?: string;
}

export interface IssueOptions {
  nodeId: string;
  runId: string;
  username: string;
  scope?: 'admin';
}

export function issue(opts: IssueOptions): [string, null] | [null, string] {
  const key = secret();
  if (!key) return [null, '未配置 SANDBOX_TICKET_SECRET'];

  const ttlMs = envInt('SANDBOX_TICKET_TTL_MS', 60000);
  const payload: TicketPayload = {
    nid: opts.nodeId,
    run: opts.runId,
    username: opts.username,
    exp: Date.now() + ttlMs,
    jti: crypto.randomUUID(),
  };
  if (opts.scope === 'admin') payload.scp = 'admin';

  const json = JSON.stringify(payload);
  const body = b64urlEncode(Buffer.from(json, 'utf-8'));
  const sig = b64urlEncode(
    crypto.createHmac('sha256', key).update(body).digest(),
  );
  return [`${body}.${sig}`, null];
}

export function verify(
  token: string,
  expectNodeId?: string,
): [TicketPayload, null] | [null, string] {
  const key = secret();
  if (!key) return [null, '未配置 SANDBOX_TICKET_SECRET'];
  if (typeof token !== 'string') return [null, '票据格式非法'];

  const match = token.match(/^([A-Za-z0-9\-_]+)\.([A-Za-z0-9\-_]+)$/);
  if (!match) return [null, '票据格式非法'];

  const [, body, sig] = match;
  const expected = b64urlEncode(
    crypto.createHmac('sha256', key).update(body).digest(),
  );

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return [null, '票据签名不匹配'];
  }

  const jsonBuf = b64urlDecode(body);
  if (!jsonBuf) return [null, '票据载荷解码失败'];

  let payload: TicketPayload;
  try {
    payload = JSON.parse(jsonBuf.toString('utf-8'));
  } catch {
    return [null, '票据载荷非法'];
  }

  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    return [null, '票据已过期'];
  }
  if (expectNodeId && payload.nid !== expectNodeId) {
    return [null, '票据不是签给本节点的'];
  }
  return [payload, null];
}
