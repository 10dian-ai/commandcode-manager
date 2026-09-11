import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const fixture = vi.hoisted(() => ({ subscribers: [] as any[] }))
vi.mock('../server/lib/redis', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    createRedisConnection: () => {
      const subscriber = new EventEmitter() as any
      subscriber.subscribe = vi.fn(async () => 1)
      subscriber.disconnect = vi.fn()
      fixture.subscribers.push(subscriber)
      return subscriber
    },
  }
})
import eventsHandler from '../server/api/events.get'

describe('SSE over a real H3 HTTP connection', () => {
  let server: Server | undefined
  let controller: AbortController
  let intervalSpy: MockInstance<typeof globalThis.setInterval>
  beforeEach(() => {
    fixture.subscribers.length = 0
    controller = new AbortController()
    intervalSpy = vi.spyOn(globalThis, 'setInterval')
  })
  afterEach(async () => {
    controller.abort()
    // Ensure a regression cannot leave the handler's heartbeat timer keeping the test process alive.
    for (const result of intervalSpy.mock.results) if (result.type === 'return') clearInterval(result.value)
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
    vi.restoreAllMocks()
  })
  it('sends response headers and ready immediately, forwards updates, then releases Redis and the heartbeat on disconnect', async () => {
    const app = createApp()
    app.use('/api/events', eventsHandler)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    const readEvent = async () => {
      let text = ''
      while (!text.includes('\n\n')) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('SSE closed before delivering an event')
        text += decoder.decode(chunk.value, { stream: true })
      }
      return text
    }
    expect(await readEvent()).toContain('event: ready\ndata: {}\n\n')
    const subscriber = fixture.subscribers[0]
    expect(subscriber.subscribe).toHaveBeenCalledExactlyOnceWith('ccm:events')
    subscriber.emit('message', 'ccm:events', JSON.stringify({ type: 'keys' }))
    expect(await readEvent()).toContain('event: update\ndata: {"type":"keys"}\n\n')
    const heartbeat = intervalSpy.mock.results[intervalSpy.mock.calls.findIndex(call => call[1] === 20000)]?.value
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    controller.abort()
    await vi.waitFor(() => {
      expect(subscriber.disconnect).toHaveBeenCalledTimes(1)
      expect(clearSpy).toHaveBeenCalledWith(heartbeat)
    }, { timeout: 1500 })
  })
})