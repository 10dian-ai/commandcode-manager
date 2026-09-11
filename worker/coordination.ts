import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { getRedis } from '../server/lib/redis'
import { getSettings } from '../server/lib/settings'

export async function rateLimitUpstream() {
  const rate=(await getSettings()).refreshRatePerSecond, redis=getRedis(), spacing=Math.ceil(1000/rate)
  const delay=Number(await redis.eval(`local current=redis.call('TIME'); local now=current[1]*1000+math.floor(current[2]/1000); local slot=math.max(now,tonumber(redis.call('GET',KEYS[1]) or '0')); redis.call('SET',KEYS[1],slot+tonumber(ARGV[1]),'PX',slot-now+tonumber(ARGV[1])+60000); return slot-now`,1,'ccm:upstream:next-request',spacing))
  if (delay>0) await sleep(delay)
}
export async function withAccountLock<T>(id:string,run:(assertLock:()=>Promise<void>)=>Promise<T>):Promise<T> {
  const redis=getRedis(), key=`ccm:sync:lock:${id}`, token=randomUUID(), until=Date.now()+60_000
  while (!await redis.set(key,token,'PX',120_000,'NX')) {
    if (Date.now()>=until) throw new Error('ACCOUNT_SYNC_BUSY')
    await sleep(250)
  }
  let lost=false
  const timer=setInterval(()=>{ void redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],120000) else return 0 end`,1,key,token).then(result=>{if(!result)lost=true}).catch(()=>{lost=true}) },30_000)
  timer.unref()
  const assertLock=async()=>{if(lost || await redis.get(key)!==token)throw new Error('ACCOUNT_SYNC_LOCK_LOST')}
  try { await assertLock(); return await run(assertLock) }
  finally { clearInterval(timer); await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,1,key,token).catch(()=>{}) }
}