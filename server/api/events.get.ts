import { createEventStream, defineEventHandler } from 'h3'
import { createRedisConnection } from '../lib/redis'
import { UPDATE_CHANNEL } from '../lib/events'
export default defineEventHandler(async event => {
  const stream = createEventStream(event)
  const subscriber = createRedisConnection()
  let closed = false
  const push = (name: string, data: string) => { if (!closed) void stream.push({ event: name, data }).catch(() => {}) }
  subscriber.on('message', (_channel, message) => push('update', message))
  await subscriber.subscribe(UPDATE_CHANNEL)
  const heartbeat = setInterval(() => push('ping', '{}'), 20000)
  stream.onClosed(() => { closed = true; clearInterval(heartbeat); subscriber.disconnect() })
  // Start consuming the TransformStream before writing: awaiting push first deadlocks on backpressure.
  const response = stream.send()
  push('ready', '{}')
  return response
})
