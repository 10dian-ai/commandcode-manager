export const SESSION_COOKIE = '__Secure-commandcode_prod_.session_token'
export interface ParsedCredential { line: number; cookie: string }
export function parseCookieText(text: string): { entries: ParsedCredential[]; duplicates: number; errors: {line:number; message:string}[] } {
  if (text.length > 2_000_000) throw new Error('导入文本不能超过 2 MB')
  const lines = text.split(/\r?\n/)
  if (lines.length > 2000) throw new Error('每批最多 2000 行')
  const entries: ParsedCredential[] = [], errors: {line:number;message:string}[] = [], seen = new Set<string>()
  let duplicates = 0
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (!line) continue
    const header = line.replace(/^cookie:\s*/i, '')
    const parts = header.split(';').map(s => s.trim())
    const matches = parts.filter(s => s.startsWith(`${SESSION_COOKIE}=`))
    let token: string
    if (matches.length === 1) token = matches[0]!.slice(SESSION_COOKIE.length + 1)
    else if (matches.length > 1 || header.includes(';') || header.includes('session_token=') || /^[\w.-]+=/.test(header) && !/^[A-Za-z0-9_+/%.-]+=*$/.test(header)) {
      errors.push({ line: index + 1, message: '每行仅提供一个 Token 或包含正确 session_token 名称的 Cookie' }); continue
    } else token = header
    // Never decode, repair, or rewrite the credential supplied by the administrator.
    if (token.length < 16 || token.length > 8192 || !/^[\x21-\x7E]+$/.test(token) || /[;,"\\]/.test(token)) {
      errors.push({ line: index + 1, message: 'Token 格式无效' }); continue
    }
    const cookie = `${SESSION_COOKIE}=${token}`
    if (seen.has(cookie)) { duplicates++; continue }
    seen.add(cookie); entries.push({ line: index + 1, cookie })
  }
  return { entries, duplicates, errors }
}