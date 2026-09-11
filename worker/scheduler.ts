import { randomUUID, createHash } from 'node:crypto'
import { getDb } from '../server/lib/db'
import { getRedis } from '../server/lib/redis'
import { getSettings } from '../server/lib/settings'
import { enqueueAccountRefresh } from '../server/lib/queues'
import { refreshCatalog } from './tasks'
export const WORKER_HEARTBEAT_KEY='ccm:worker:heartbeat'
let ticking=false
export async function schedulerTick() {
  if(ticking)return
  ticking=true
  const redis=getRedis(),token=randomUUID(),lock='ccm:worker:scheduler-lock'
  let acquired=false
  try {
    await redis.set(WORKER_HEARTBEAT_KEY,new Date().toISOString(),'EX',45)
    acquired=!!await redis.set(lock,token,'PX',120_000,'NX')
    if(!acquired)return
    const settings=await getSettings(),sql=getDb(),now=Date.now()
    const rows=await sql`SELECT id,status,last_sync_at,last_used_at FROM managed_accounts WHERE enabled=true AND status<>'credential_expired' ORDER BY last_sync_at ASC NULLS FIRST LIMIT 2000`
    for(const row of rows) {
      const interval=(row.last_used_at && now-new Date(row.last_used_at).getTime()<settings.activeWindowSeconds*1000 ? settings.activeRefreshSeconds : settings.idleRefreshSeconds)*1000
      const spread=createHash('sha256').update(row.id).digest().readUInt32BE(0)%Math.max(1000,Math.floor(interval/5))
      const age=row.last_sync_at ? now-new Date(row.last_sync_at).getTime() : Infinity
      if(age<interval+spread)continue
      if(await redis.exists(`ccm:refresh:backoff:${row.id}`))continue
      await enqueueAccountRefresh(row.id,{reason:'scheduled'})
    }
    const catalogDate=await redis.get('ccm:catalog:last-attempt')
    if(!catalogDate || now-Number(catalogDate)>3600_000) {
      await redis.set('ccm:catalog:last-attempt',String(now))
      try {await refreshCatalog();await redis.del('ccm:catalog:error')}catch{await redis.set('ccm:catalog:error','Model catalog refresh failed','EX',7200)}
    }
    if(await redis.set('ccm:logs:cleanup-slot','1','EX',3600,'NX')) {
      let deleted=1000
      while(deleted===1000) {
        const result=await sql`DELETE FROM request_logs WHERE id IN (SELECT id FROM request_logs WHERE created_at<now()-(${settings.logRetentionDays} * INTERVAL '1 day') LIMIT 1000) RETURNING id`
        deleted=result.length
      }
    }
  } finally {
    if(acquired)await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,1,lock,token).catch(()=>{})
    ticking=false
  }
}