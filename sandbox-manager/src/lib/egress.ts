import crypto from 'crypto';
import { envStr } from '../config';

export interface EgressTarget {
  host: string;
  ports: number[];
}

export interface EgressPolicy {
  mode: string;
  allow: EgressTarget[];
  leaseAllow: EgressTarget[];
  revision: string;
}

function validHost(host: string): boolean {
  if (typeof host !== 'string') return false;
  if (host.length === 0 || host.length > 253) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9.\-_]*$/.test(host)) return false;
  if (/[.\-_]$/.test(host)) return false;
  return true;
}

export function parseTargets(raw: string): EgressTarget[] {
  const out: EgressTarget[] = [];
  for (const item of String(raw || '').split(',')) {
    const entry = item.trim();
    if (!entry) continue;

    const colonIdx = entry.indexOf(':');
    let host: string;
    let portRaw: string | null;

    if (colonIdx >= 0) {
      host = entry.substring(0, colonIdx);
      portRaw = entry.substring(colonIdx + 1);
    } else {
      host = entry;
      portRaw = null;
    }

    if (!validHost(host)) continue;

    if (portRaw === null) {
      out.push({ host, ports: [80, 443] });
    } else {
      const port = parseInt(portRaw, 10);
      if (!isNaN(port) && port === Math.floor(port) && port >= 1 && port <= 65535) {
        out.push({ host, ports: [port] });
      }
    }
  }
  return out;
}

function canonical(mode: string, allow: EgressTarget[], leaseAllow: EgressTarget[]): string {
  function join(list: EgressTarget[]): string {
    return list
      .map((t) => `${t.host}:${t.ports.join('/')}`)
      .sort()
      .join(',');
  }
  return `${mode}|${join(allow)}|${join(leaseAllow)}`;
}

export function policy(): EgressPolicy {
  let mode = envStr('SANDBOX_EGRESS_MODE', 'allowlist');
  if (mode !== 'open') mode = 'allowlist';

  const allow = parseTargets(envStr('SANDBOX_EGRESS_ALLOW'));
  const leaseAllow = parseTargets(envStr('SANDBOX_EGRESS_LEASE_ALLOW'));

  const revision = crypto
    .createHash('sha256')
    .update(canonical(mode, allow, leaseAllow))
    .digest('hex')
    .substring(0, 8);

  return { mode, allow, leaseAllow, revision };
}

export function wire(): {
  mode: string;
  revision: string;
  allow: EgressTarget[];
  leaseAllow: EgressTarget[];
} {
  const p = policy();
  return {
    mode: p.mode,
    revision: p.revision,
    allow: p.allow,
    leaseAllow: p.leaseAllow,
  };
}
