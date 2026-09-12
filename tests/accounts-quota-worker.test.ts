import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from 'bullmq'
import type { AccountSnapshot } from '../shared/types'
import type { ImportJobData } from '../server/lib/queues'
import { CommandCodeClient, CommandCodeError } from '../server/lib/commandcode'

const fixture=vi.hoisted(()=>({
  account:{id:'account-id',upstream_user_id:'user-id',credential_fingerprint:'fingerprint',cookie_ciphertext:'encrypted-cookie',snapshot:null as AccountSnapshot|null},
  lost:false,
  failureWrites:vi.fn(),
  save:vi.fn(async(..._args:unknown[])=>[{id:'account-id'}]),
  complete:vi.fn(async(..._args:unknown[])=>[{id:'account-id'}]),
  ensureKey:vi.fn(async()=>{}),
  redis:{incr:vi.fn(async()=>1),expire:vi.fn(async()=>1),set:vi.fn(async()=>'OK'),del:vi.fn(async()=>1)},
  publish:vi.fn(async()=>{}),
}))
vi.mock('../server/lib/db',()=>{
  const sql:any=(strings:TemplateStringsArray,..._values:unknown[])=>{
    const query=strings.join('?')
    if(query.startsWith('AND ') || !query.trim())return {}
    if(query.startsWith('SELECT * FROM managed_accounts'))return Promise.resolve([fixture.account])
    if(query.includes('UPDATE managed_accounts SET status=?')){
      fixture.failureWrites()
      return Promise.resolve([{id:fixture.account.id}])
    }
    throw new Error('Unexpected query: '+query)
  }
  return {getDb:()=>sql}
})
vi.mock('../server/lib/redis',()=>({getRedis:()=>fixture.redis}))
vi.mock('../server/lib/crypto',()=>({decryptSecret:()=> 'fake-cookie'}))
vi.mock('../server/lib/accounts',()=>({
  createPendingAccount:async()=>fixture.account,
  attachIdentity:async()=>({account:fixture.account,updated:false}),
}))
vi.mock('../server/lib/account-quota',()=>({saveAccountSnapshot:fixture.save,completeAccountSync:fixture.complete}))
vi.mock('../server/lib/events',()=>({publishUpdate:fixture.publish}))
vi.mock('../worker/coordination',()=>({rateLimitUpstream:async()=>{},withAccountLock:async(_id:string,run:(assertLock:()=>Promise<void>)=>Promise<unknown>)=>run(async()=>{
  if(fixture.lost)throw new Error('ACCOUNT_SYNC_LOCK_LOST')
})}))
vi.mock('../worker/keys',()=>({ensureDedicatedKey:fixture.ensureKey}))
import { processImport, syncAccount } from '../worker/tasks'

function snapshot(full=false):AccountSnapshot {
  return {identity:{id:'user-id',name:'Quota test',email:null},credits:{},windowLimits:{weekly:{used:full?10:2,cap:10,exceeded:full,resetAt:Date.now()+60_000}},
    subscription:{planId:null,status:null,currentPeriodStart:null,currentPeriodEnd:null,cancelAtPeriodEnd:null},usage:{},fetchedAt:new Date().toISOString()}
}
function expectNoFailureState(){
  expect(fixture.failureWrites).not.toHaveBeenCalled()
  expect(fixture.redis.incr).not.toHaveBeenCalled()
  expect(fixture.redis.set).not.toHaveBeenCalled()
}

beforeEach(()=>{
  vi.restoreAllMocks();vi.clearAllMocks()
  fixture.lost=false;fixture.account.snapshot=snapshot()
  fixture.save.mockResolvedValue([{id:'account-id'}]);fixture.ensureKey.mockResolvedValue()
})

describe('quota sync ownership at asynchronous boundaries',()=>{
  it('passes the originally loaded snapshot to the atomic quota write',async()=>{
    const initial=fixture.account.snapshot,fresh=snapshot(true)
    vi.spyOn(CommandCodeClient.prototype,'snapshot').mockResolvedValue(fresh)
    await syncAccount('account-id')
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith('account-id','fingerprint',fresh,initial)
    expect(fixture.complete).toHaveBeenCalledExactlyOnceWith('account-id','fingerprint',fresh)
    expectNoFailureState()
  })
  it('does not save, complete or mark a failed sync when ownership is lost while fetching quota',async()=>{
    vi.spyOn(CommandCodeClient.prototype,'snapshot').mockImplementation(async()=>{fixture.lost=true;return snapshot(true)})
    await expect(syncAccount('account-id')).rejects.toThrow('ACCOUNT_SYNC_LOCK_LOST')
    expect(fixture.save).not.toHaveBeenCalled();expect(fixture.complete).not.toHaveBeenCalled()
    expect(fixture.publish).not.toHaveBeenCalled();expectNoFailureState()
  })
  it('does not overwrite newer status when an upstream error arrives after ownership is lost',async()=>{
    vi.spyOn(CommandCodeClient.prototype,'snapshot').mockImplementation(async()=>{fixture.lost=true;throw new CommandCodeError('UPSTREAM_UNAVAILABLE',503)})
    await expect(syncAccount('account-id')).rejects.toThrow('ACCOUNT_SYNC_LOCK_LOST')
    expect(fixture.save).not.toHaveBeenCalled();expectNoFailureState()
  })
  it('does not complete or mark failure when ownership is lost while ensuring the dedicated key',async()=>{
    vi.spyOn(CommandCodeClient.prototype,'snapshot').mockResolvedValue(snapshot())
    fixture.ensureKey.mockImplementation(async()=>{fixture.lost=true})
    await expect(syncAccount('account-id')).rejects.toThrow('ACCOUNT_SYNC_LOCK_LOST')
    expect(fixture.save).toHaveBeenCalledTimes(1);expect(fixture.complete).not.toHaveBeenCalled()
    expect(fixture.publish).not.toHaveBeenCalled();expectNoFailureState()
  })
  it('stops after a compare-and-swap rejection without completing or clearing newer retry state',async()=>{
    vi.spyOn(CommandCodeClient.prototype,'snapshot').mockResolvedValue(snapshot())
    fixture.save.mockResolvedValue([])
    await syncAccount('account-id')
    expect(fixture.ensureKey).not.toHaveBeenCalled();expect(fixture.complete).not.toHaveBeenCalled()
    expect(fixture.redis.del).not.toHaveBeenCalled();expect(fixture.publish).not.toHaveBeenCalled();expectNoFailureState()
  })
  it('still records real synchronization errors while this worker owns the account',async()=>{
    vi.spyOn(CommandCodeClient.prototype,'snapshot').mockRejectedValue(new CommandCodeError('UPSTREAM_UNAVAILABLE',503))
    await expect(syncAccount('account-id')).rejects.toMatchObject({status:503})
    expect(fixture.failureWrites).toHaveBeenCalledTimes(1)
    expect(fixture.redis.incr).toHaveBeenCalledTimes(1)
  })
  it('keeps import failure handling from writing stale account status after a lost lock',async()=>{
    vi.spyOn(CommandCodeClient.prototype,'session').mockResolvedValue({user:{id:'user-id'}})
    vi.spyOn(CommandCodeClient.prototype,'snapshot').mockImplementation(async()=>{fixture.lost=true;throw new CommandCodeError('UPSTREAM_UNAVAILABLE',503)})
    const job={data:{entries:[{line:1,ciphertext:'encrypted-cookie',fingerprint:'fingerprint'}],rejected:[],duplicates:0},
      updateProgress:vi.fn(async()=>{}),updateData:vi.fn(async()=>{})}
    const result=await processImport(job as unknown as Job<ImportJobData>)
    expect(result).toMatchObject({imported:0,updated:0,failed:1})
    expect(result.errors[0]?.message).toBe('ACCOUNT_SYNC_LOCK_LOST')
    expect(fixture.save).not.toHaveBeenCalled();expectNoFailureState()
  })
})
