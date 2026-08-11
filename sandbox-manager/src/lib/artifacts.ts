import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { envStr, envInt } from '../config';

export interface ArtifactsConfig {
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
  endpoint: string;
  prefix: string;
  putExpires: number;
  getExpires: number;
  maxBytes: number;
}

export function config(): ArtifactsConfig {
  const region = envStr('SANDBOX_ARTIFACTS_OSS_REGION', 'cn-north-1');
  return {
    accessKey: envStr('S3_ACCESS_KEY'),
    secretKey: envStr('S3_SECRET_KEY'),
    region,
    bucket: envStr('SANDBOX_ARTIFACTS_OSS_BUCKET', 'public'),
    endpoint: envStr(
      'SANDBOX_ARTIFACTS_OSS_ENDPOINT',
      `https://s3.us-east-1.amazonaws.com`,
    ),
    prefix: envStr('SANDBOX_ARTIFACTS_PREFIX', 'sandbox-artifacts'),
    putExpires: envInt('SANDBOX_ARTIFACTS_PUT_EXPIRES_SEC', 900),
    getExpires: envInt('SANDBOX_ARTIFACTS_GET_EXPIRES_SEC', 7 * 24 * 3600),
    maxBytes: envInt('SANDBOX_ARTIFACTS_MAX_BYTES', 200 * 1024 * 1024),
  };
}

export function enabled(): boolean {
  const cfg = config();
  return cfg.accessKey !== '' && cfg.secretKey !== '' && cfg.bucket !== '';
}

export function host(): string {
  return config().endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

export function safeFileName(raw: string): string {
  const base = String(raw || '').trim().replace(/.*\//, '');
  const safe = base
    .replace(/[^\w.\-]/g, '_')
    .replace(/^\.+/, '')
    .substring(0, 120);
  return safe || 'artifact.bin';
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^\w.\-]/g, '_')
    .substring(0, 64);
  if (!cleaned || /^\.+$/.test(cleaned)) return fallback;
  return cleaned;
}

export function buildKey(
  username: string,
  runId: string,
  fileName: string,
  nonce?: string,
): string {
  const cfg = config();
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const id = nonce || crypto.randomUUID().replace(/-/g, '').substring(0, 16);
  return [
    cfg.prefix.replace(/^\/+/, '').replace(/\/+$/, ''),
    safeSegment(username, 'unknown'),
    day,
    safeSegment(runId, 'norun'),
    id,
    safeFileName(fileName),
  ].join('/');
}

function getClient(): S3Client {
  const cfg = config();
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
    forcePathStyle: true,
  });
}

export interface SignResult {
  key: string;
  uploadUrl: string;
  downloadUrl: string;
  expiresIn: number;
  maxBytes: number;
}

export async function sign(
  username: string,
  runId: string,
  fileName: string,
): Promise<[SignResult, null] | [null, string]> {
  if (!enabled()) {
    return [
      null,
      '未配置对象存储（需要 S3_ACCESS_KEY / S3_SECRET_KEY / SANDBOX_ARTIFACTS_OSS_BUCKET）',
    ];
  }

  const cfg = config();
  const client = getClient();
  const key = buildKey(username, runId, fileName);

  try {
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: cfg.bucket, Key: key }),
      { expiresIn: cfg.putExpires },
    );
    const downloadUrl = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
      { expiresIn: cfg.getExpires },
    );

    return [
      { key, uploadUrl, downloadUrl, expiresIn: cfg.putExpires, maxBytes: cfg.maxBytes },
      null,
    ];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return [null, '产物地址签发失败: ' + msg];
  }
}
