import { FastifyRequest, FastifyReply } from 'fastify';

let validCodes: Set<string> | null = null;

function loadCodes(): Set<string> {
  if (!validCodes) {
    const raw = process.env.API_SECURITY_CODES || '';
    validCodes = new Set(raw.split(/[,\s]+/).filter(Boolean));
  }
  return validCodes;
}

export async function apiKeyAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const code = request.headers['x-api-securitycode'] as string | undefined;
  if (!code) {
    reply.code(401).send({
      ok: false,
      error: 'missing-security-code',
      message: '缺少 X-API-SecurityCode 头',
    });
    return;
  }

  const codes = loadCodes();
  if (codes.size === 0 || !codes.has(code)) {
    reply.code(401).send({
      ok: false,
      error: 'invalid-security-code',
      message: '无效的安全令牌',
    });
    return;
  }
}
