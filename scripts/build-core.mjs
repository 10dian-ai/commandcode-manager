import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CORE_SOURCE_SHA256 = 'd395956d2fdec6dc0fac5051fccb388e40c8c25b5fdb2211204b5b4a0c6dfaa0'
export const CORE_COMMIT = '6217305'
export const CORE_CLI_VERSION = '1.53.0'
export const CORE_PATCHES = [
  'preserve-responses-prompt-cache-key',
  'accept-responses-message-without-type',
  'require-upstream-finish-before-responses-completion',
  'reject-responses-store-true',
  'pin-cli-version-without-network-refresh',
]
function replaceOnce(source, before, after, label) {
  const at = source.indexOf(before)
  if (at < 0 || source.indexOf(before, at + before.length) !== -1)
    throw new Error('Core patch anchor is missing or ambiguous: ' + label)
  return source.slice(0, at) + after + source.slice(at + before.length)
}
export function applyCorePatches(original) {
  const hash = createHash('sha256').update(original).digest('hex')
  if (hash !== CORE_SOURCE_SHA256)
    throw new Error('Core source checksum mismatch; review the source before changing the lock')
  let source = original.toString('utf8').replace(/\r\n/g, '\n')
  const versionStart = source.indexOf("let CC_VERSION = '0.32.3';")
  const versionEndMarker = 'setInterval(refreshCCVersion, CC_VERSION_REFRESH_MS);'
  const versionEnd = source.indexOf(versionEndMarker, versionStart)
  if (versionStart < 0 || versionEnd < versionStart) throw new Error('Core version pin anchors are missing')
  source = source.slice(0, versionStart) +
    "// CommandCode Manager build: version is pinned; upgrades require a reviewed build.\n" +
    "const CC_VERSION = '" + CORE_CLI_VERSION + "';\n" +
    source.slice(versionEnd + versionEndMarker.length)

  const start = source.indexOf('function responsesTextOf(')
  const end = source.indexOf('async function handleModels(', start)
  if (start < 0 || end < start) throw new Error('Responses section not found')
  let section = source.slice(start, end)
  section = replaceOnce(section,
    "      switch (item.type) {",
    "      const itemType = item.type === undefined && ['user', 'assistant', 'system', 'developer'].includes(item.role) ? 'message' : item.type;\n      switch (itemType) {",
    'implicit message')
  section = replaceOnce(section,
    '  if (eff) out.reasoning_effort = eff;\n  return out;',
    "  if (eff) out.reasoning_effort = eff;\n  if (typeof respReq.prompt_cache_key === 'string') out.prompt_cache_key = respReq.prompt_cache_key;\n  return out;",
    'prompt cache key')
  section = replaceOnce(section,
    '  if (respReq.previous_response_id) {',
    "  if (respReq.store === true) {\n    sendResponsesError(res, 400, 'invalid_request_error', 'store:true is not supported (this proxy is stateless)');\n    return;\n  }\n\n  if (respReq.previous_response_id) {",
    'store rejection')
  section = replaceOnce(section,
    '  let finishReason = null;',
    '  let finishReason = null;\n  let finishReceived = false;',
    'stream finish tracking')
  section = replaceOnce(section,
    "        case 'finish': {\n          finishReason = event.finishReason || null;",
    "        case 'finish': {\n          finishReceived = true;\n          finishReason = event.finishReason || null;",
    'stream finish observation')
  section = replaceOnce(section,
    '    finish() {\n      if (!createdSent) return [];',
    "    finish() {\n      if (!createdSent) return [];\n      if (!finishReceived) return this.fail('Upstream stream ended without finish event');",
    'stream EOF validation')
  section = replaceOnce(section,
    "      let finishReason = 'stop';",
    "      let finishReason = 'stop';\n      let finishReceived = false;",
    'nonstream finish tracking')
  section = replaceOnce(section,
    "            case 'finish':\n              lastCcEvent = event.type;",
    "            case 'finish':\n              finishReceived = true;\n              lastCcEvent = event.type;",
    'nonstream finish observation')
  section = replaceOnce(section,
    '      idle.dispose();\n      processLines();',
    "      idle.dispose();\n      if (buf.trim()) buf += '\\n';\n      processLines();",
    'unterminated final NDJSON line')
  section = replaceOnce(section,
    '      if (!fullText && !thinkingText && !toolCalls.length) {',
    "      if (!finishReceived) {\n        sendResponsesError(res, 502, 'upstream_error', 'Upstream stream ended without finish event');\n        return;\n      }\n\n      if (!fullText && !thinkingText && !toolCalls.length) {",
    'nonstream EOF validation')
  return source.slice(0, start) + section + source.slice(end)
}
export async function buildCore(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const input = resolve(root, 'reference/commandcode-proxy-' + CORE_COMMIT)
  const output = resolve(root, 'core/dist')
  const source = applyCorePatches(await readFile(resolve(input, 'proxy.mjs')))
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, 'proxy.mjs'), source, 'utf8')
  await copyFile(resolve(input, 'LICENSE'), resolve(output, 'LICENSE'))
  const config = JSON.parse(await readFile(resolve(input, 'config.json'), 'utf8'))
  await writeFile(resolve(output, 'config.json'), JSON.stringify({ ...config, port: 3050, host: '0.0.0.0', logFile: '' }, null, 2) + '\n', 'utf8')
  await writeFile(resolve(output, 'build-manifest.json'), JSON.stringify({
    repository: 'MAXeaglet/commandcode-proxy', commit: CORE_COMMIT,
    sourceSha256: CORE_SOURCE_SHA256, builtSha256: createHash('sha256').update(source).digest('hex'),
    cliVersion: CORE_CLI_VERSION, patches: CORE_PATCHES,
  }, null, 2) + '\n', 'utf8')
  return output
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildCore()
  console.log('Core built at ' + output)
}