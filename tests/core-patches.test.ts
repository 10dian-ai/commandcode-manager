import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
// The build script is intentionally plain ESM and runs no server when imported.
// @ts-ignore The build utility is plain JavaScript; its behavior is covered here.
import { applyCorePatches, CORE_CLI_VERSION, CORE_SOURCE_SHA256 } from '../scripts/build-core.mjs'

const original = readFileSync(resolve('reference/commandcode-proxy-6217305/proxy.mjs'))
const patched: string = applyCorePatches(original)
type TestExports = {
  convertResponsesToChat: (request: Record<string, unknown>) => Record<string, unknown>
  createResponsesSseTranslator: (model: string, id: string, created: number) => {
    parseLine: (line: string) => string[] | null
    finish: () => string[]
  }
  handleResponses: (req: object, res: object) => Promise<void>
}
function harness(body: Record<string, unknown> = {}, upstreamText = '') {
  const responsesOnly = patched.slice(patched.indexOf('function responsesTextOf('), patched.indexOf('async function handleModels('))
  const sent: { status: number; body: unknown }[] = []
  let upstreamCalls = 0
  const context = vm.createContext({
    randomUUID, nowUnix: () => 1_790_000_000,
    normalizeUsage: () => {},
    mapFinishReason: (reason: string) => reason,
    mapCcEventError: (event: { message?: string }) => ({ status: 502, body: { error: { type: 'upstream_error', message: event.message } } }),
    sendJSON: (_res: object, status: number, value: unknown) => { sent.push({ status, body: value }) },
    readBody: async () => body,
    getApiKey: () => 'fixture-key-no-network',
    buildCcRequest: (value: unknown) => value,
    ensureInitialized: async () => {},
    forwardToCC: async () => {
      upstreamCalls++
      return new Response(upstreamText, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    },
    AbortController, TextDecoder, Date,
    createIdleWatchdog: () => ({ arm: () => new Promise(() => {}), dispose: () => {} }),
    NONSTREAM_IDLE_TIMEOUT_MS: 1000,
    log: () => {},
    consecutiveTimeouts: 0,
  })
  vm.runInContext(responsesOnly + '\nglobalThis.testExports = { convertResponsesToChat, createResponsesSseTranslator, handleResponses };', context)
  const exports = context.testExports as TestExports
  const request = { headers: {} }
  const response = { writableEnded: false, headersSent: false, destroyed: false, on: () => {} }
  return { ...exports, sent, request, response, upstreamCalls: () => upstreamCalls }
}

describe('reviewed fixed-core build', () => {
  it('refuses a changed upstream source instead of silently applying uncertain patches', () => {
    expect(CORE_SOURCE_SHA256).toHaveLength(64)
    expect(() => applyCorePatches(Buffer.concat([original, Buffer.from('\n')]))).toThrow('checksum mismatch')
  })
  it('pins the reviewed CLI version and removes the registry refresher', () => {
    expect(patched).toContain("const CC_VERSION = '" + CORE_CLI_VERSION + "';")
    expect(patched).not.toContain('refreshCCVersion()')
    expect(patched).not.toContain('setInterval(refreshCCVersion')
    expect(patched).not.toContain('https://registry.npmjs.org/command-code/latest')
  })
})

describe('Responses compatibility patches execute the patched source in isolation', () => {
  it('preserves prompt_cache_key and a valid message without explicit type', () => {
    const chat = harness().convertResponsesToChat({
      model: 'fixture/model', prompt_cache_key: 'conversation-cache',
      input: [{ role: 'developer', content: 'Instructions' }, { role: 'user', content: 'Hello' }],
    })
    expect(chat.prompt_cache_key).toBe('conversation-cache')
    expect(chat.messages).toEqual([{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Hello' }])
  })
  it('retains typed function call/output round trips', () => {
    const chat = harness().convertResponsesToChat({
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
      ],
    })
    expect(chat.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
    ])
  })
  it('rejects store:true before any upstream request', async () => {
    const h = harness({ store: true, model: 'fixture/model', input: 'Hello' })
    await h.handleResponses(h.request, h.response)
    expect(h.sent[0]?.status).toBe(400)
    expect(JSON.stringify(h.sent[0]?.body)).toContain('store:true is not supported')
    expect(h.upstreamCalls()).toBe(0)
  })
  it('emits response.failed on stream EOF without an upstream finish', () => {
    const translator = harness().createResponsesSseTranslator('fixture/model', 'resp_test', 1)
    translator.parseLine(JSON.stringify({ type: 'text-delta', text: 'partial' }))
    const end = translator.finish().join('')
    expect(end).toContain('response.failed')
    expect(end).toContain('without finish event')
    expect(end).not.toContain('response.completed')
  })
  it('still emits completed or incomplete after a real finish event', () => {
    for (const reason of ['stop', 'length']) {
      const translator = harness().createResponsesSseTranslator('fixture/model', 'resp_test', 1)
      translator.parseLine(JSON.stringify({ type: 'text-delta', text: 'answer' }))
      translator.parseLine(JSON.stringify({ type: 'finish', finishReason: reason, usage: { inputTokens: 1, outputTokens: 1 } }))
      expect(translator.finish().join('')).toContain(reason === 'length' ? 'response.incomplete' : 'response.completed')
    }
  })
  it('returns an error on non-stream EOF without finish instead of a successful partial answer', async () => {
    const h = harness({ model: 'fixture/model', input: 'Hello' }, JSON.stringify({ type: 'text-delta', text: 'partial' }) + '\n')
    await h.handleResponses(h.request, h.response)
    expect(h.sent[0]?.status).toBe(502)
    expect(JSON.stringify(h.sent[0]?.body)).toContain('without finish event')
  })
  it('accepts a complete final NDJSON finish line without a trailing newline', async () => {
    const wire = JSON.stringify({ type: 'text-delta', text: 'answer' }) + '\n' +
      JSON.stringify({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } })
    const h = harness({ model: 'fixture/model', input: 'Hello', store: false }, wire)
    await h.handleResponses(h.request, h.response)
    expect(h.sent[0]?.status).toBe(200)
    expect(h.sent[0]?.body).toMatchObject({ status: 'completed', output_text: 'answer' })
  })
})