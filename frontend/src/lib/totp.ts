/** 用共享密钥算 TOTP（RFC 6238）。默认 30 秒、6 位、SHA-1。 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

export interface TotpParams {
  /** 规范化后的 Base32，不含空格和填充 */
  secretText: string
  secret: Uint8Array
  digits: number
  period: number
  algorithm: TotpAlgorithm
  /** otpauth 里的发行方和账号，没有就是空串 */
  label: string
}

export interface TotpInterpret {
  params: TotpParams | null
  /** 空串表示还没输入完，或输入是空的 */
  error: string
}

const HASH: Record<TotpAlgorithm, string> = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA512: 'SHA-512'
}

function decodeBase32(input: string): Uint8Array | null {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '')
  if (clean.length < 8 || clean.length > 128) return null
  if ([...clean].some((char) => !BASE32.includes(char))) return null
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return out.length > 0 ? Uint8Array.from(out) : null
}

function algorithmOf(raw: string | null): TotpAlgorithm | null {
  const name = (raw ?? 'SHA1').replace(/-/g, '').toUpperCase()
  if (name === 'SHA1' || name === 'SHA256' || name === 'SHA512') return name
  return null
}

function paramsFrom(secretText: string, digits: number, period: number, algorithm: TotpAlgorithm, label: string): TotpParams | null {
  const secret = decodeBase32(secretText)
  if (!secret) return null
  return { secretText: secretText.toUpperCase().replace(/[\s=-]/g, ''), secret, digits, period, algorithm, label }
}

function labelOf(url: URL): string {
  const path = decodeURIComponent(url.pathname.replace(/^\//, '')).trim()
  const issuerQuery = (url.searchParams.get('issuer') ?? '').trim()
  const split = path.indexOf(':')
  const issuer = issuerQuery || (split >= 0 ? path.slice(0, split).trim() : '')
  const account = (split >= 0 ? path.slice(split + 1) : path).trim()
  if (issuer && account) return `${issuer} (${account})`
  return issuer || account
}

function fromOtpAuth(input: string): TotpInterpret {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { params: null, error: '' }
  }
  if (url.protocol !== 'otpauth:') return { params: null, error: '密钥格式不对' }
  if (url.hostname.toLowerCase() !== 'totp') return { params: null, error: '只支持 TOTP' }
  const secret = url.searchParams.get('secret') ?? ''
  if (!secret.trim()) return { params: null, error: input.includes('secret=') ? '密钥格式不对' : '' }
  const digits = Number(url.searchParams.get('digits') ?? '6')
  const period = Number(url.searchParams.get('period') ?? '30')
  const algorithm = algorithmOf(url.searchParams.get('algorithm'))
  if (!algorithm || !Number.isInteger(digits) || digits < 6 || digits > 8 || !Number.isInteger(period) || period < 1 || period > 300) {
    return { params: null, error: '密钥格式不对' }
  }
  const params = paramsFrom(secret, digits, period, algorithm, labelOf(url))
  return params ? { params, error: '' } : { params: null, error: '密钥格式不对' }
}

/** 密钥、otpauth 链接，或还在输入中的半截内容。 */
export function interpretTotp(input: string): TotpInterpret {
  const text = input.trim()
  if (!text) return { params: null, error: '' }
  if (/^otpauth:/i.test(text)) return fromOtpAuth(text)
  const compact = text.toUpperCase().replace(/[\s-]/g, '')
  if (/[^A-Z2-7=]/.test(compact)) return { params: null, error: '密钥格式不对' }
  if (compact.replace(/=/g, '').length < 8) return { params: null, error: '' }
  const params = paramsFrom(compact, 6, 30, 'SHA1', '')
  return params ? { params, error: '' } : { params: null, error: '密钥格式不对' }
}

function counterBytes(counter: number): ArrayBuffer {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setUint32(0, Math.floor(counter / 2 ** 32))
  view.setUint32(4, counter >>> 0)
  return buffer
}

/** unix 秒对应的验证码。同一周期内结果不变。 */
export async function totpAt(params: TotpParams, unixSeconds: number): Promise<string> {
  const raw = new ArrayBuffer(params.secret.byteLength)
  new Uint8Array(raw).set(params.secret)
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: HASH[params.algorithm] }, false, ['sign'])
  const counter = Math.floor(unixSeconds / params.period)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(counter)))
  const offset = mac[mac.length - 1] & 0x0f
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff)
  return String(bin % 10 ** params.digits).padStart(params.digits, '0')
}
