import { describe, expect, it } from 'vitest'
import { ResponseCapture, ResponseInspection } from '../server/lib/gateway/response'
const encoder = new TextEncoder()
const sse = (data: unknown) => encoder.encode('data: ' + JSON.stringify(data) + '\n\n')

describe('stream completion and usage evidence', () => {
  it('handles UTF-8 and SSE boundaries split over arbitrary network chunks', () => {
    const inspection = new ResponseInspection()
    const wire = encoder.encode(
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
    )
    for (let i = 0; i < wire.length; i += 2) inspection.push(wire.subarray(i, i + 2))
    inspection.end()
    expect(inspection.hasOutput).toBe(true)
    expect(inspection.completed).toBe(true)
    expect(inspection.usage).toEqual({ input_tokens: 3, output_tokens: 2 })
    expect(inspection.failure).toBeNull()
  })
  it('does not turn a partial text stream into a completed request', () => {
    const inspection = new ResponseInspection()
    inspection.push(sse({ choices: [{ delta: { content: 'partial result' } }] }))
    inspection.end()
    expect(inspection.hasOutput).toBe(true)
    expect(inspection.completed).toBe(false)
    expect(inspection.usage).toBeNull()
  })
  it('detects an error arriving after HTTP 200 and some output', () => {
    const inspection = new ResponseInspection()
    inspection.push(sse({ choices: [{ delta: { content: 'partial' } }] }))
    inspection.push(sse({ error: { type: 'rate_limit_error', message: 'Response timeout - request timed out' } }))
    inspection.end()
    expect(inspection.failure?.category).toBe('timeout')
    expect(inspection.failure?.safeToRetry).toBe(false)
  })
  it('keeps real Anthropic usage fields instead of inventing a total', () => {
    const inspection = new ResponseInspection()
    inspection.push(sse({ type: 'message_start', message: { usage: { input_tokens: 8, cache_read_input_tokens: 4, output_tokens: 0 } } }))
    inspection.push(sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reasoning' } }))
    inspection.push(sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } }))
    inspection.push(sse({ type: 'message_stop' }))
    inspection.end()
    expect(inspection.usage).toEqual({ input_tokens: 8, cache_read_input_tokens: 4, output_tokens: 5 })
    expect(inspection.incomplete).toBe(true)
    expect(inspection.hasOutput).toBe(true)
  })
  it('does not treat usage or HTTP-success-shaped envelopes as model output', () => {
    const inspection = new ResponseInspection()
    inspection.observe({ choices: [{ message: { content: null }, finish_reason: 'stop' }], usage: { completion_tokens: 15 } })
    expect(inspection.hasOutput).toBe(false)
    expect(inspection.completed).toBe(true)
  })
  it('recognizes tool-only responses and preserves upstream missing usage as null', () => {
    const inspection = new ResponseInspection()
    inspection.observe({ status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{}' }] })
    expect(inspection.hasOutput).toBe(true)
    expect(inspection.usage).toBeNull()
  })
})

describe('response log byte limit', () => {
  it('keeps the full business payload within the cap and marks truncation beyond it', () => {
    const capture = new ResponseCapture(10)
    capture.push(encoder.encode('12345'))
    capture.push(encoder.encode('6789012345'))
    expect(capture.text()).toBe('1234567890')
    expect(capture.value(true)).toEqual({ format: 'sse', raw: '1234567890', truncated: true })
  })
  it('stores JSON as an object without changing response content', () => {
    const capture = new ResponseCapture()
    capture.push(encoder.encode('{"answer":"你好","usage":{"input_tokens":3}}'))
    expect(capture.value(false)).toEqual({ answer: '你好', usage: { input_tokens: 3 } })
    expect(capture.truncated).toBe(false)
  })
})