import { DelayedError, UnrecoverableError, type Job } from 'bullmq'
import { getDb } from '../server/lib/db'
import { getRedis } from '../server/lib/redis'
import { decryptSecret } from '../server/lib/crypto'
import { CommandCodeClient, CommandCodeError } from '../server/lib/commandcode'
import { createPendingAccount, attachIdentity } from '../server/lib/accounts'
import { saveAccountSnapshot, completeAccountSync } from '../server/lib/account-quota'
import type { ImportJobData } from '../server/lib/queues'
import { publishUpdate } from '../server/lib/events'
import type { ImportResult, AccountSnapshot } from '../shared/types'
import { rateLimitUpstream, withAccountLock } from './coordination'
import { ensureDedicatedKey } from './keys'
export const client = new CommandCodeClient({ beforeRequest: rateLimitUpstream })
export function syncErrorMessage(error:unknown): string {
  if(error instanceof CommandCodeError)return error.message
  if(error instanceof Error && /^(KEY_[A-Z_]+:|ACCOUNT_SYNC_)/.test(error.message))return error.message.slice(0,300)
  return 'SYNC_FAILED: 同步失败，请稍后重试；上次成功快照已保留'
}
export async function markSyncFailure(id:string,error:unknown,fingerprint?:string) {
  const sql=getDb(), expired=error instanceof CommandCodeError && error.credentialExpired
  await sql`UPDATE managed_accounts SET status=${expired?'credential_expired':'sync_error'},sync_error=${syncErrorMessage(error)},updated_at=now()
    WHERE id=${id} ${fingerprint ? sql`AND credential_fingerprint=${fingerprint}` : sql``}`
  const retry=error instanceof CommandCodeError ? error.retryAfterMs : 0
  const attempts=await getRedis().incr(`ccm:refresh:failures:${id}`)
  await getRedis().expire(`ccm:refresh:failures:${id}`,86400)
  await getRedis().set(`ccm:refresh:backoff:${id}`,'1','PX',Math.max(retry,Math.min(3600_000,30_000*2**Math.min(attempts,7))))
  await publishUpdate({type:'accounts',accountId:id})
}
export async function syncAccount(id:string,priorSession?:unknown):Promise<void> {
  const redirected = await withAccountLock(id,async(assertLock)=>{
    const sql=getDb(), rows=await sql`SELECT * FROM managed_accounts WHERE id=${id}`
    if(!rows.length)return
    const account=rows[0]!, cookie=decryptSecret(account.cookie_ciphertext)
    const scopedClient=new CommandCodeClient({beforeRequest:async()=>{await rateLimitUpstream();await assertLock()}})
    try {
      const snapshot=await scopedClient.snapshot(cookie,priorSession)
      await assertLock()
      if(account.upstream_user_id && snapshot.identity.id!==account.upstream_user_id)throw new CommandCodeError('SESSION_IDENTITY_CHANGED',401,true)
      if(!account.upstream_user_id) {
        const attached=await attachIdentity(id,snapshot.identity,account.credential_fingerprint,account.cookie_ciphertext)
        if(attached.account.id!==id)return attached.account.id as string
      }
      const updated=await saveAccountSnapshot(id,account.credential_fingerprint,snapshot,account.snapshot ?? null)
      if(!updated.length)return
      await assertLock(); await ensureDedicatedKey(id,cookie,scopedClient)
      await assertLock(); await completeAccountSync(id,account.credential_fingerprint,snapshot)
      await getRedis().del(`ccm:refresh:backoff:${id}`,`ccm:refresh:failures:${id}`)
      await publishUpdate({type:'accounts',accountId:id})
    } catch(error) {
      // A worker that lost ownership must not overwrite a newer sync's status.
      try { await assertLock() } catch { throw new Error('ACCOUNT_SYNC_LOCK_LOST') }
      await markSyncFailure(id,error,account.credential_fingerprint);throw error
    }
  })
  if(redirected)await syncAccount(redirected)
}
interface Checkpoint { next:number; result:ImportResult }
export async function processImport(job:Job<ImportJobData & {checkpoint?:Checkpoint}>):Promise<ImportResult> {
  const {entries,groupName}=job.data
  const checkpoint=job.data.checkpoint ?? {next:0,result:{imported:0,updated:0,failed:job.data.rejected.length,skipped:job.data.duplicates,errors:[...job.data.rejected]}}
  const result=checkpoint.result
  await job.updateProgress({processed:checkpoint.next,total:entries.length})
  for(let i=checkpoint.next;i<entries.length;i++) {
    const entry=entries[i]!
    let accountId:string|undefined
    try {
      const pending=await createPendingAccount(entry.fingerprint,entry.ciphertext,groupName)
      accountId=pending.id
      const cookie=decryptSecret(entry.ciphertext), session=await client.session(cookie)
      const user=(session as {user:{id:string;name?:string;email?:string}}).user
      if(!user || typeof user.id!=='string')throw new CommandCodeError('INVALID_SESSION',401,true)
      const identity:AccountSnapshot['identity']={id:user.id,name:user.name??user.id,email:user.email??null}
      const attached=await attachIdentity(pending.id,identity,entry.fingerprint,entry.ciphertext,groupName)
      accountId=attached.account.id
      await syncAccount(accountId!,session)
      if(attached.updated)result.updated++;else result.imported++
    } catch(error) {
      if(accountId && !(error instanceof Error && error.message==='ACCOUNT_SYNC_LOCK_LOST'))await markSyncFailure(accountId,error,entry.fingerprint)
      result.failed++;result.errors.push({line:entry.line,message:syncErrorMessage(error)})
    }
    await job.updateData({...job.data,checkpoint:{next:i+1,result}})
    await job.updateProgress({processed:i+1,total:entries.length})
  }
  await publishUpdate({type:'accounts'})
  return result
}
export async function processRefresh(job:Job<{accountId:string;reason?:string}>,token?:string) {
  const redis=getRedis(),key=`ccm:refresh:dirty:${job.data.accountId}`, version=await redis.get(key)
  const backoff=await redis.pttl(`ccm:refresh:backoff:${job.data.accountId}`)
  if(backoff>0 && (job.attemptsMade>0 || job.data.reason!=='manual')) {
    await job.moveToDelayed(Date.now()+backoff,token)
    throw new DelayedError()
  }
  try {await syncAccount(job.data.accountId)}
  catch(error) {
    if(error instanceof CommandCodeError && error.credentialExpired)throw new UnrecoverableError(error.message)
    throw error
  }
  await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,1,key,version??'')
}
export async function refreshCatalog() {
  const models=await client.catalog(),sql=getDb()
  await sql.begin(async tx=> {
    for(const model of models)await tx`INSERT INTO model_catalog(model_id,name,metadata) VALUES(${model.id},${model.name},${sql.json(model.metadata as any)})
      ON CONFLICT(model_id) DO UPDATE SET name=EXCLUDED.name,metadata=EXCLUDED.metadata,updated_at=now()`
    await tx`DELETE FROM model_catalog WHERE model_id NOT IN ${sql(models.map(m=>m.id))}`
  })
  await getRedis().set('ccm:catalog:updatedAt',new Date().toISOString())
  await publishUpdate({type:'models'})
}