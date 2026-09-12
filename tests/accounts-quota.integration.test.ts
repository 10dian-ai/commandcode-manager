import { randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import type { AccountSnapshot } from '../shared/types'
import { migrate } from '../server/lib/migrations'

const fixture=vi.hoisted(()=>({sql:undefined as Sql|undefined,enqueue:vi.fn(async()=>{}),publish:vi.fn(async()=>{})}))
vi.mock('../server/lib/db',()=>({getDb:()=>fixture.sql}))
vi.mock('../server/lib/queues',()=>({enqueueAccountRefresh:fixture.enqueue}))
vi.mock('../server/lib/events',()=>({publishUpdate:fixture.publish}))
vi.mock('../server/lib/redis',()=>({getRedis:()=>({pipeline:()=>{
  const pipeline={zcount:()=>pipeline,exec:async()=>[[null,0]]};return pipeline
}})}))
import { saveAccountSnapshot, completeAccountSync } from '../server/lib/account-quota'
import { patchAccount } from '../server/lib/accounts'

const databaseUrl=process.env.TEST_DATABASE_URL
const schema='ccm_quota_test_'+randomUUID().replaceAll('-','')
const future=()=>Date.now()+3600_000
function snapshot(windows:AccountSnapshot['windowLimits']):AccountSnapshot {
  return {identity:{id:'test-user',name:'Quota test',email:null},credits:{},windowLimits:windows,
    subscription:{planId:null,status:null,currentPeriodStart:null,currentPeriodEnd:null,cancelAtPeriodEnd:null},usage:{},fetchedAt:new Date().toISOString()}
}
const window=(full:boolean,resetAt=future())=>({used:full?10:2,cap:10,exceeded:full,resetAt})

describe.skipIf(!databaseUrl)('persistent quota pause and recovery in PostgreSQL',()=>{
  let admin:Sql,sql:Sql,created=false
  beforeAll(async()=>{
    admin=postgres(databaseUrl!,{max:1,connect_timeout:5,onnotice:()=>{}})
    await admin`CREATE SCHEMA ${admin(schema)}`;created=true
    sql=postgres(databaseUrl!,{max:1,connect_timeout:5,onnotice:()=>{},connection:{search_path:schema}})
    fixture.sql=sql
    await migrate(sql)
  },30000)
  afterAll(async()=>{
    if(sql)await sql.end({timeout:5})
    if(admin){try{if(created && /^ccm_quota_test_[a-f0-9]{32}$/.test(schema))await admin`DROP SCHEMA ${admin(schema)} CASCADE`}finally{await admin.end({timeout:5})}}
  },30000)
  async function account(enabled=true){
    const id=randomUUID(),fingerprint=randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext,api_key_ciphertext,status,enabled)
      VALUES(${id},${fingerprint},'encrypted-test','encrypted-key','ready',${enabled})`
    return {id,fingerprint}
  }
  const read=async(id:string)=>(await sql`SELECT enabled,quota_paused,quota_resume_at,quota_pause_reasons,status FROM managed_accounts WHERE id=${id}`)[0]!
  const previousSnapshot=async(id:string)=>(await sql`SELECT snapshot FROM managed_accounts WHERE id=${id}`)[0]!.snapshot as AccountSnapshot|null
  async function sync(a:{id:string;fingerprint:string},data:AccountSnapshot){
    expect(await saveAccountSnapshot(a.id,a.fingerprint,data,await previousSnapshot(a.id))).toHaveLength(1)
    await completeAccountSync(a.id,a.fingerprint,data)
  }
  it.each(['fiveHour','weekly','monthly'] as const)('pauses %s exhaustion without deleting and recovers only after fresh confirmation',async key=>{
    const a=await account(),resetAt=future()
    await sync(a,snapshot({[key]:window(true,resetAt)}))
    expect(await read(a.id)).toMatchObject({enabled:false,quota_paused:true,quota_pause_reasons:[key],status:'ready'})
    expect(new Date((await read(a.id)).quota_resume_at).getTime()).toBe(resetAt)
    await migrate(sql)
    expect((await read(a.id)).quota_paused).toBe(true)
    await sync(a,snapshot({[key]:window(false)}))
    expect(await read(a.id)).toMatchObject({enabled:true,quota_paused:false,quota_resume_at:null,quota_pause_reasons:[]})
  })
  it('retains the latest reset among all exhausted windows and never resumes while one is full',async()=>{
    const a=await account(),early=future(),late=early+86400_000
    await sync(a,snapshot({fiveHour:window(true,early),weekly:window(true,late)}))
    expect(new Date((await read(a.id)).quota_resume_at).getTime()).toBe(late)
    await sync(a,snapshot({fiveHour:window(false),weekly:window(true,late)}))
    expect(await read(a.id)).toMatchObject({enabled:false,quota_paused:true})
  })
  it('does not release a still-exhausted fresh response just because its reset is in the past',async()=>{
    const a=await account()
    await sync(a,snapshot({fiveHour:window(true,Date.now()-60000)}))
    expect(await read(a.id)).toMatchObject({enabled:false,quota_paused:true})
  })
  it('keeps unknown reset times null and missing recovery observations paused',async()=>{
    const a=await account()
    await sync(a,snapshot({weekly:window(true,0)}))
    expect(await read(a.id)).toMatchObject({enabled:false,quota_paused:true,quota_resume_at:null})
    await sync(a,snapshot({fiveHour:window(false)}))
    expect(await read(a.id)).toMatchObject({enabled:false,quota_paused:true,quota_pause_reasons:['weekly']})
  })
  it('never takes ownership of a manually disabled account',async()=>{
    const a=await account(false)
    await sync(a,snapshot({weekly:window(true)}))
    expect(await read(a.id)).toMatchObject({enabled:false,quota_paused:false,quota_resume_at:null})
    await sync(a,snapshot({weekly:window(false)}))
    expect((await read(a.id)).enabled).toBe(false)
  })
  it('preserves a manual disable between snapshot and ready writes and supports cancelling recovery',async()=>{
    const a=await account(),healthy=snapshot({weekly:window(false)})
    await sync(a,snapshot({weekly:window(true)}))
    await saveAccountSnapshot(a.id,a.fingerprint,healthy,await previousSnapshot(a.id))
    await patchAccount(a.id,{enabled:false})
    await completeAccountSync(a.id,a.fingerprint,healthy)
    expect(await read(a.id)).toMatchObject({enabled:false,quota_paused:false,quota_resume_at:null,quota_pause_reasons:[]})
  })
  it('editing metadata preserves automatic recovery and enable requests first recheck paused accounts',async()=>{
    const a=await account()
    await sync(a,snapshot({weekly:window(true)}))
    await patchAccount(a.id,{note:'keep paused'})
    expect((await read(a.id)).quota_paused).toBe(true)
    fixture.enqueue.mockClear()
    const result=await patchAccount(a.id,{enabled:true})
    expect(result).toMatchObject({enabled:false,quotaPaused:true})
    expect(fixture.enqueue).toHaveBeenCalledExactlyOnceWith(a.id,{reason:'manual',force:true})
  })
  it('does not apply a stale credential refresh after credential replacement',async()=>{
    const a=await account()
    await sql`UPDATE managed_accounts SET credential_fingerprint=${randomUUID()} WHERE id=${a.id}`
    expect(await saveAccountSnapshot(a.id,a.fingerprint,snapshot({weekly:window(true)}),null)).toHaveLength(0)
    expect((await read(a.id)).enabled).toBe(true)
  })
  it('does not lose an unconfirmed weekly pause when a later snapshot only reports five-hour exhaustion',async()=>{
    const a=await account()
    await sync(a,snapshot({weekly:window(true)}))
    await sync(a,snapshot({fiveHour:window(true)}))
    expect((await read(a.id)).quota_pause_reasons.sort()).toEqual(['fiveHour','weekly'])
    await sync(a,snapshot({fiveHour:window(false)}))
    expect(await read(a.id)).toMatchObject({enabled:false,quota_paused:true})
    await sync(a,snapshot({fiveHour:window(false),weekly:window(false)}))
    expect(await read(a.id)).toMatchObject({enabled:true,quota_paused:false})
  })
  it('recovers a real monthly balance even when the upstream omitted the monthly grant',async()=>{
    const a=await account(),data=snapshot({limited:true})
    data.credits={monthlyCredits:0}
    await sync(a,data)
    expect(await read(a.id)).toMatchObject({enabled:false,quota_paused:true,quota_pause_reasons:['monthly']})
    data.credits={monthlyCredits:10}
    await sync(a,data)
    expect(await read(a.id)).toMatchObject({enabled:true,quota_paused:false})
  })
  it('does not let a stale overlapping refresh clear a newer exhausted snapshot',async()=>{
    const a=await account(),healthy=snapshot({weekly:window(false)}),full=snapshot({weekly:window(true)})
    await saveAccountSnapshot(a.id,a.fingerprint,healthy,null)
    await saveAccountSnapshot(a.id,a.fingerprint,full,healthy)
    expect(await completeAccountSync(a.id,a.fingerprint,healthy)).toHaveLength(0)
    expect(await read(a.id)).toMatchObject({enabled:false,quota_paused:true,quota_pause_reasons:['weekly']})
  })
  it.each([false,true])('rejects an older snapshot saved after a newer response (newer exhausted: %s)',async newerFull=>{
    const a=await account(),initial=snapshot({weekly:window(false)}),older=snapshot({weekly:window(!newerFull)}),newer=snapshot({weekly:window(newerFull)})
    newer.fetchedAt=new Date(Date.now()+1000).toISOString()
    await sync(a,initial)
    const expected=await previousSnapshot(a.id)
    expect(await saveAccountSnapshot(a.id,a.fingerprint,newer,expected)).toHaveLength(1)
    await completeAccountSync(a.id,a.fingerprint,newer)
    const state=await read(a.id)
    expect(await saveAccountSnapshot(a.id,a.fingerprint,older,expected)).toHaveLength(0)
    expect(await previousSnapshot(a.id)).toEqual(newer)
    expect(await read(a.id)).toEqual(state)
    expect(state).toMatchObject({enabled:!newerFull,quota_paused:newerFull,quota_pause_reasons:newerFull?['weekly']:[]})
  })
})
