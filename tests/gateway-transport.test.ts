import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { ServerResponse } from 'node:http'
import type { H3Event } from 'h3'
import { describe, expect, it } from 'vitest'
import { readJsonBodyLimited, writeWithBackpressure } from '../server/lib/gateway/transport'

function blockedResponse() {
  const response = new EventEmitter() as EventEmitter & { destroyed: boolean; write: () => boolean }
  response.destroyed = false
  response.write = () => false
  return response
}
describe('backpressure and cancellation', () => {
  it('waits for downstream drain before reading more upstream data', async () => {
    const response = blockedResponse()
    const controller = new AbortController()
    let finished = false
    const write = writeWithBackpressure(response as unknown as ServerResponse, new Uint8Array([1]), controller.signal)
      .then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    response.emit('drain')
    await write
    expect(finished).toBe(true)
    expect(response.listenerCount('close')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
  })
  it('unblocks on cancellation and removes drain/error/close listeners', async () => {
    const response = blockedResponse()
    const controller = new AbortController()
    const write = writeWithBackpressure(response as unknown as ServerResponse, new Uint8Array([1]), controller.signal)
    controller.abort(new Error('Cancelled by client'))
    await expect(write).rejects.toThrow('Cancelled by client')
    expect(response.listenerCount('drain')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
  })
  it('unblocks when the downstream socket closes while waiting for drain', async () => {
    const response = blockedResponse()
    const write = writeWithBackpressure(response as unknown as ServerResponse, new Uint8Array([1]), new AbortController().signal)
    response.destroyed = true
    response.emit('close')
    await expect(write).rejects.toThrow('Client disconnected')
    expect(response.listenerCount('drain')).toBe(0)
  })
})
describe('bounded request intake', () => {
  function event(chunks: string[], length?: string) {
    const request = Readable.from(chunks.map(chunk => Buffer.from(chunk))) as Readable & { headers: Record<string, string> }
    request.headers = length ? { 'content-length': length } : {}
    return { node: { req: request } } as unknown as H3Event
  }
  it('enforces the byte cap on chunked bodies without content-length', async () => {
    await expect(readJsonBodyLimited(event(['{"input":"', 'x'.repeat(20), '"}']), 16)).rejects.toMatchObject({ statusCode: 413 })
  })
  it('keeps a valid business request intact and rejects non-object JSON', async () => {
    expect(await readJsonBodyLimited(event(['{"model":"test","input":"你好"}']), 100)).toEqual({ model: 'test', input: '你好' })
    await expect(readJsonBodyLimited(event(['null']), 100)).rejects.toMatchObject({ statusCode: 400 })
  })
})