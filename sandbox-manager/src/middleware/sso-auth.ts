import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import type { AuthUser } from '../lib/console';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

function sessionSecret(): string {
  return process.env.SESSION_SECRET || process.env.SANDBOX_TICKET_SECRET || '';
}

function sessionTtlSec(): number {
  const hours = parseInt(process.env.SESSION_TTL_HOURS || '24', 10);
  return (isNaN(hours) ? 24 : hours) * 3600;
}

let parsedUsers: Map<string, string> | null = null;

/**
 * 解析 CONSOLE_USERS 环境变量。格式：username:password,username2:password2
 */
export function getUsers(): Map<string, string> {
  if (!parsedUsers) {
    parsedUsers = new Map();
    const raw = process.env.CONSOLE_USERS || '';
    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx <= 0) continue;
      const username = trimmed.substring(0, colonIdx);
      const password = trimmed.substring(colonIdx + 1);
      if (username && password) {
        parsedUsers.set(username, password);
      }
    }
  }
  return parsedUsers;
}

/**
 * 校验用户名/密码。使用常量时间比较防止计时攻击。
 */
export function validateCredentials(
  username: string,
  password: string,
): boolean {
  const users = getUsers();
  const expected = users.get(username);
  if (expected === undefined) return false;

  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 签发 JWT 会话令牌。
 */
export function signSessionToken(username: string): {
  token: string;
  expiresAt: number;
} {
  const secret = sessionSecret();
  const ttl = sessionTtlSec();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttl;

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: username, iat: now, exp: expiresAt }),
  ).toString('base64url');

  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return { token: `${header}.${payload}.${sig}`, expiresAt: expiresAt * 1000 };
}

/**
 * 验证 JWT 令牌并提取用户信息。
 */
function verifySessionToken(token: string): AuthUser | null {
  const secret = sessionSecret();
  if (!secret) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const headerPayload = `${parts[0]}.${parts[1]}`;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(headerPayload)
      .digest('base64url');

    if (expectedSig !== parts[2]) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    );

    if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) {
      return null;
    }

    const username = payload.sub;
    if (typeof username !== 'string' || !username) return null;

    return { username };
  } catch {
    return null;
  }
}

/**
 * 会话认证中间件。
 *
 * 从 Authorization: Bearer <jwt> 头中提取并校验会话令牌。
 * login 路由不经过此中间件。
 */
export async function sessionAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const user = verifySessionToken(token);
    if (user) {
      request.authUser = user;
      return;
    }
  }

  reply.code(401).send({
    ok: false,
    error: 'unauthenticated',
    message: '需要登录',
  });
}
