import { getRedis } from './redis'
export const UPDATE_CHANNEL = 'ccm:events'
export async function publishUpdate(event: { type: string; accountId?: string }) {
  await getRedis().publish(UPDATE_CHANNEL, JSON.stringify(event))
}
