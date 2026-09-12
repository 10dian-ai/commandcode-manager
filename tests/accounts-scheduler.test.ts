import { beforeEach,describe,it,expect,vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/types'

const fixture=vi.hoisted(()=>({
  accounts:[] as {id:string;status:string;last_sync_at:string|null;last_used_at:null;quota_paused?:boolean;quota_resume_at?:string|null}[],
  values:new Map<string,string>(),
  enqueue:vi.fn(async()=>{}),
  queries:0,
  backoffs:true,
}))
vi.mock('../server/lib/db',()=>({getDb:()=>async(strings:TemplateStringsArray,...values:unknown[])=>{
  const query=strings.join('?')
  if(query.includes('SELECT id,status,last_sync_at,last_used_at')){
    fixture.queries++
    const cursor=values[0] as string|null
    return fixture.accounts.filter(account=>!cursor||account.id>cursor).slice(0,2000)
  }
  return []
}}))
vi.mock('../server/lib/redis',()=>({getRedis:()=>({
  get:async(key:string)=>fixture.values.get(key)??null,
  set:async(key:string,value:string,...args:unknown[])=>{
    if(args.includes('NX')&&fixture.values.has(key))return null
    fixture.values.set(key,value);return 'OK'
  },
  del:async(key:string)=>fixture.values.delete(key)?1:0,
  exists:async(key:string)=>!fixture.backoffs || key.endsWith('000000002001')?0:1,
  eval:async(_script:string,_count:number,key:string,token:string)=>{
    if(fixture.values.get(key)!==token)return 0
    fixture.values.delete(key);return 1
  },
})}))
vi.mock('../server/lib/settings',()=>({getSettings:async()=>DEFAULT_SETTINGS}))
vi.mock('../server/lib/queues',()=>({enqueueAccountRefresh:fixture.enqueue}))
vi.mock('../worker/tasks',()=>({refreshCatalog:async()=>{}}))
import { schedulerTick } from '../worker/scheduler'

describe('large account-pool periodic refresh',()=>{
  beforeEach(()=>{
    fixture.accounts=Array.from({length:2001},(_,i)=>({id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),status:'sync_error',last_sync_at:null,last_used_at:null}))
    fixture.values.clear();fixture.enqueue.mockClear();fixture.queries=0;fixture.backoffs=true
    fixture.values.set('ccm:catalog:last-attempt',String(Date.now()))
    fixture.values.set('ccm:logs:cleanup-slot','1')
  })
  it('reaches accounts after 2000 backed-off accounts without making any scan unbounded',async()=>{
    await schedulerTick()
    expect(fixture.enqueue).not.toHaveBeenCalled()
    expect(fixture.queries).toBe(1)
    await schedulerTick()
    expect(fixture.enqueue).toHaveBeenCalledExactlyOnceWith(fixture.accounts[2000]!.id,{reason:'scheduled'})
    expect(fixture.queries).toBe(2)
    expect(fixture.values.has('ccm:worker:scheduler-cursor')).toBe(false)
    await schedulerTick()
    expect(fixture.queries).toBe(3)
    expect(fixture.enqueue).toHaveBeenCalledTimes(1)
  })
  it('checks a paused account at its known reset even if it synced recently',async()=>{
    fixture.backoffs=false
    fixture.accounts=[{id:'due',status:'ready',last_sync_at:new Date(Date.now()-2000).toISOString(),last_used_at:null,
      quota_paused:true,quota_resume_at:new Date(Date.now()-1000).toISOString()}]
    await schedulerTick()
    expect(fixture.enqueue).toHaveBeenCalledExactlyOnceWith('due',{reason:'scheduled'})
  })
  it('waits for a future reset and avoids polling a stale exhausted response every tick',async()=>{
    fixture.backoffs=false
    fixture.accounts=[
      {id:'future',status:'ready',last_sync_at:null,last_used_at:null,quota_paused:true,quota_resume_at:new Date(Date.now()+60000).toISOString()},
      {id:'already-checked',status:'ready',last_sync_at:new Date().toISOString(),last_used_at:null,quota_paused:true,quota_resume_at:new Date(Date.now()-1000).toISOString()},
    ]
    await schedulerTick()
    expect(fixture.enqueue).not.toHaveBeenCalled()
  })
  it('periodically rechecks paused accounts whose reset time is unknown',async()=>{
    fixture.backoffs=false
    fixture.accounts=[{id:'unknown-reset',status:'ready',last_sync_at:null,last_used_at:null,quota_paused:true,quota_resume_at:null}]
    await schedulerTick()
    expect(fixture.enqueue).toHaveBeenCalledExactlyOnceWith('unknown-reset',{reason:'scheduled'})
  })
})
