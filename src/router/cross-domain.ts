/**
 * 跨域目标判定：只按 DID 的域名匹配，不按整条 DID。
 *
 * DID 的路径段会随部署变化，域名才是部署边界；允许清单里也不接受协议、
 * 路径与端口。`*.` 前缀表示「该域名下的任意子域」。
 */

const HOST_PATTERN = /^(?:\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** 校验并归一化一条允许域名；不合法时返回 null。 */
export function parseAllowedHost(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (host === '' || !HOST_PATTERN.test(host)) return null;
  return host;
}

/** `did:wba:<host>:…` / `did:web:<host>:…` 里的 host（丢掉 `%3A` 编码的端口）。 */
export function didHostOf(did: string): string | undefined {
  const match = /^did:(?:wba|web):([^:]+)/i.exec(did.trim());
  if (!match) return undefined;
  let authority: string;
  try {
    authority = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  // 双重编码会让 URL 解析再解一次；DID 段里不接受残留的 `%`。
  if (authority.includes('%')) return undefined;
  const host = /^([A-Za-z0-9.-]+)(?::\d+)?$/.exec(authority)?.[1];
  return host?.toLowerCase();
}

/** 精确匹配或 `*.` 子域匹配。 */
export function didHostAllowed(did: string, allowedHosts: readonly string[]): boolean {
  const host = didHostOf(did);
  if (!host) return false;
  for (const raw of allowedHosts) {
    const pattern = raw.toLowerCase();
    if (pattern.startsWith('*.')) {
      if (host.endsWith(`.${pattern.slice(2)}`)) return true;
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}
