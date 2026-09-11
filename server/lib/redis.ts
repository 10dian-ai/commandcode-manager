import Redis from 'ioredis'
import { getConfig } from './config'
let redis: Redis | undefined
const connections = new Set<Redis>()
export function createRedisConnection(): Redis {
  const client = new Redis(getConfig().redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true })
  client.on('error', () => {})
  connections.add(client)
  client.on('end', () => connections.delete(client))
  return client
}
export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(getConfig().redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 5000, commandTimeout: 10000, enableAutoPipelining: true })
    redis.on('error', () => {})
  }
  return redis
}
export async function closeRedis() {
  const all = [...connections, ...(redis ? [redis] : [])]
  await Promise.all(all.map(async client => { try { await client.quit() } catch { client.disconnect() } }))
  connections.clear(); redis = undefined
}
