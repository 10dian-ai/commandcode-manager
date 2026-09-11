import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest'
const fixture=vi.hoisted(()=>({jobs:new Map<string,any>(),values:new Map<string,string>(),scores:new Map<string,number>(),added:[] as any[],cooldown:0}))
vi.mock('bullmq',()=>({Queue:class {
  constructor(_name:string,_options:unknown){}
  toKey(name:string){return `test-refresh:${name}`}
  async getJob(id:string){return fixture.jobs.get(id)}
  async add(_name:string,data:any,opts:any){
    fixture.added.push({data,opts})
    const job:any={id:opts.jobId,data,priority:opts.priority,delay:opts.delay,state:opts.delay?'delayed':'prioritized',
      getState:vi.fn(async()=>job.state),
      changePriority:vi.fn(async({priority}:any)=>{job.priority=priority}),
      updateData:vi.fn(async(data:any)=>{job.data=data}),
      promote:vi.fn(async()=>{job.state='prioritized';fixture.scores.delete(job.id)}),
      changeDelay:vi.fn(async(delay:number)=>{job.delay=delay;fixture.scores.set(job.id,(Date.now()+delay)*4096)}),
      remove:vi.fn(async()=>{fixture.jobs.delete(job.id)}),
    }
    fixture.jobs.set(job.id,job)
    if(opts.delay)fixture.scores.set(job.id,(Date.now()+opts.delay)*4096)
    return job
  }
}}))
vi.mock('../server/lib/redis',()=>({
  createRedisConnection:()=>({}),
  getRedis:()=>({
    set:async(key:string,value:string)=>{if(fixture.values.has(key))return null;fixture.values.set(key,value);return 'OK'},
    eval:async(_script:string,_count:number,key:string)=>{fixture.values.delete(key);return 1},
    pttl:async()=>fixture.cooldown,
    zscore:async(_key:string,id:string)=>fixture.scores.has(id)?String(fixture.scores.get(id)):null,
    multi:()=>{
      const operations:(()=>void)[]=[]
      const chain:any={incr:(key:string)=>{operations.push(()=>fixture.values.set(key,String(Number(fixture.values.get(key)??0)+1)));return chain},expire:()=>chain,exec:async()=>{operations.forEach(fn=>fn());return []}}
      return chain
    },
  }),
}))
vi.mock('../server/lib/crypto',()=>({encryptSecret:()=>{throw new Error('Not used')},fingerprint:()=>{throw new Error('Not used')}}))
vi.mock('../server/lib/db',()=>({getDb:()=>{throw new Error('No database required for refresh scheduling')}}))
import { enqueueAccountRefresh,REFRESH_PRIORITY } from '../server/lib/queues'

describe('active account refresh scheduling',()=>{
  beforeEach(()=>{fixture.jobs.clear();fixture.values.clear();fixture.scores.clear();fixture.added.length=0;fixture.cooldown=0;vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-11T00:00:00Z'))})
  afterEach(()=>{vi.useRealTimers()})
  it('lets an existing active-account refresh overtake a backlog of 400 idle-account jobs without duplication',async()=>{
    for(let i=0;i<400;i++)await enqueueAccountRefresh(`idle-${i}`,{reason:'scheduled'})
    await enqueueAccountRefresh('active-account',{reason:'scheduled'})
    await enqueueAccountRefresh('active-account',{reason:'request'})
    const next=[...fixture.jobs.values()].sort((a,b)=>a.priority-b.priority)[0]
    expect(next.id).toBe('refresh-active-account')
    expect(next.priority).toBe(REFRESH_PRIORITY.request)
    expect(fixture.added).toHaveLength(401)
    expect(next.changePriority).toHaveBeenCalledExactlyOnceWith({priority:REFRESH_PRIORITY.request})
    await enqueueAccountRefresh('active-account',{reason:'scheduled'})
    expect(next.priority).toBe(REFRESH_PRIORITY.request)
  })
  it('shortens an existing delayed periodic job once and never slides the ten-second coalescing deadline',async()=>{
    fixture.cooldown=60_000
    await enqueueAccountRefresh('account',{reason:'scheduled'})
    fixture.cooldown=0
    await enqueueAccountRefresh('account',{reason:'request'})
    const job=fixture.jobs.get('refresh-account'),due=fixture.scores.get(job.id)
    expect(job.changeDelay).toHaveBeenCalledExactlyOnceWith(10_000)
    vi.setSystemTime(Date.now()+9000)
    await enqueueAccountRefresh('account',{reason:'request'})
    expect(job.changeDelay).toHaveBeenCalledTimes(1)
    expect(fixture.scores.get(job.id)).toBe(due)
    expect(fixture.added).toHaveLength(1)
  })
  it('does not let request priority bypass an explicit upstream cooldown',async()=>{
    fixture.cooldown=60_000
    await enqueueAccountRefresh('account',{reason:'scheduled'})
    const job=fixture.jobs.get('refresh-account')
    await enqueueAccountRefresh('account',{reason:'request'})
    expect(job.priority).toBe(REFRESH_PRIORITY.request)
    expect(job.changeDelay).not.toHaveBeenCalled()
    expect(job.promote).not.toHaveBeenCalled()
  })
  it('promotes an existing delayed job immediately for a forced manual refresh',async()=>{
    fixture.cooldown=60_000
    await enqueueAccountRefresh('account',{reason:'scheduled'})
    await enqueueAccountRefresh('account',{reason:'manual',force:true})
    const job=fixture.jobs.get('refresh-account')
    expect(job.priority).toBe(REFRESH_PRIORITY.manual)
    expect(job.promote).toHaveBeenCalledTimes(1)
    expect(job.data.reason).toBe('manual')
    expect(fixture.added).toHaveLength(1)
  })
  it('records requests during an active refresh without rescheduling it or allowing periodic ticks to create extra follow-ups',async()=>{
    await enqueueAccountRefresh('account',{reason:'scheduled'})
    const job=fixture.jobs.get('refresh-account');job.state='active'
    const dirty='ccm:refresh:dirty:account'
    await enqueueAccountRefresh('account',{reason:'scheduled'})
    expect(fixture.values.get(dirty)).toBe('1')
    await enqueueAccountRefresh('account',{reason:'request'})
    await enqueueAccountRefresh('account',{reason:'request'})
    expect(fixture.values.get(dirty)).toBe('3')
    expect(job.changePriority).not.toHaveBeenCalled();expect(job.changeDelay).not.toHaveBeenCalled();expect(job.promote).not.toHaveBeenCalled()
    expect(fixture.added).toHaveLength(1)
  })
})