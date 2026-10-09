/**
 * Cloudflare Access JWT verification for Workers with Static Assets.
 * Cloudflare's static-assets router does not forward ctx.access to the user
 * Worker, so verify Cf-Access-Jwt-Assertion against Access's rotating JWKS.
 * Never trust an unverified email header or JWT payload.
 *
 * This module deliberately uses the Workers Web Crypto API without extra
 * runtime dependencies. The signature/issuer/audience/expiry are all checked.
 */

export class AccessAuthError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'AccessAuthError'
    this.status = status
    this.code = code
  }
}
const deny = (status, code, message) => { throw new AccessAuthError(status, code, message) }
const keyCaches = new Map()
const TEN_MINUTES = 10 * 60_000
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function decode64url(input) {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input) || input.length > 20_000) throw Error('invalid base64url')
  const raw = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = raw + '='.repeat((4 - raw.length % 4) % 4)
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0))
}
function decodePart(input) { return JSON.parse(decoder.decode(decode64url(input))) }
function issuerFromEnv(env) {
  const value = String(env.ACCESS_TEAM_DOMAIN || '').replace(/\/$/, '')
  if (!/^https:\/\/[a-z\d-]+\.cloudflareaccess\.com$/.test(value))
    deny(503, 'ACCESS_CONFIG', 'ACCESS_TEAM_DOMAIN 未配置或格式不正确')
  if (typeof env.ACCESS_AUD !== 'string' || !env.ACCESS_AUD.trim())
    deny(503, 'ACCESS_CONFIG', 'ACCESS_AUD 未配置')
  return value
}

async function loadKeys(issuer, fetcher) {
  const url = `${issuer}/cdn-cgi/access/certs`
  let response
  try { response = await fetcher(url, { signal: AbortSignal.timeout(5000) }) }
  catch { deny(503, 'ACCESS_KEYS_UNAVAILABLE', '无法连接 Cloudflare Access 验签服务') }
  if (!response.ok) deny(503, 'ACCESS_KEYS_UNAVAILABLE', 'Cloudflare Access 公钥服务暂不可用')
  let result
  try { result = await response.json() } catch { /* failed closed below */ }
  if (!Array.isArray(result?.keys) || !result.keys.length || result.keys.length > 20)
    deny(503, 'ACCESS_KEYS_UNAVAILABLE', 'Cloudflare Access 公钥集无效')
  const keys = new Map()
  for (const jwk of result.keys) {
    if (typeof jwk?.kid !== 'string' || !jwk.kid || jwk.kty !== 'RSA' || !jwk.n || !jwk.e || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue
    keys.set(jwk.kid, jwk)
  }
  if (!keys.size) deny(503, 'ACCESS_KEYS_UNAVAILABLE', '未找到有效的 Cloudflare Access 公钥')
  keyCaches.set(issuer, { keys, imports: new Map(), expires: Date.now() + TEN_MINUTES })
  return keyCaches.get(issuer)
}

/** Returns the verified email claim, or throws AccessAuthError. */
export async function verifyAccessToken(token, env, fetcher = fetch) {
  const issuer = issuerFromEnv(env) // fail closed on missing production configuration
  if (typeof token !== 'string' || !token || token.length > 12_000)
    deny(401, 'ACCESS_REQUIRED', '缺少 Cloudflare Access 身份令牌')
  const parts = token.split('.')
  if (parts.length !== 3) deny(401, 'INVALID_ACCESS_TOKEN', '身份令牌格式无效')
  let header, payload, signature
  try {
    header = decodePart(parts[0])
    payload = decodePart(parts[1])
    signature = decode64url(parts[2])
  } catch { deny(401, 'INVALID_ACCESS_TOKEN', '身份令牌格式无效') }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256)
    deny(401, 'INVALID_ACCESS_TOKEN', '身份令牌算法无效')

  let cache = keyCaches.get(issuer)
  if (!cache || Date.now() >= cache.expires || !cache.keys.has(header.kid)) cache = await loadKeys(issuer, fetcher)
  const jwk = cache.keys.get(header.kid)
  if (!jwk) deny(401, 'INVALID_ACCESS_TOKEN', '身份令牌签名密钥无效')
  let key = cache.imports.get(header.kid)
  if (!key) {
    try {
      key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
      cache.imports.set(header.kid, key)
    } catch { deny(503, 'ACCESS_KEYS_UNAVAILABLE', 'Cloudflare Access 公钥无法导入') }
  }
  let verified = false
  try {
    verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, encoder.encode(`${parts[0]}.${parts[1]}`))
  } catch { /* invalid signature */ }
  if (!verified) deny(401, 'INVALID_ACCESS_TOKEN', '身份令牌签名无效')

  const now = Math.floor(Date.now() / 1000)
  const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud]
  if (payload?.iss !== issuer || !audiences.includes(env.ACCESS_AUD) ||
      typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now ||
      (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now + 30)) ||
      (payload.iat !== undefined && (typeof payload.iat !== 'number' || payload.iat > now + 30)) ||
      (payload.type !== undefined && payload.type !== 'app'))
    deny(401, 'INVALID_ACCESS_TOKEN', '身份令牌已过期或不属于此应用')

  const email = payload.email
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    deny(401, 'INVALID_ACCESS_TOKEN', '身份令牌没有有效邮箱')
  return email.toLowerCase()
}
