import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { getRedis } from './redis'
import { getSettings } from './settings'
import { publishUpdate } from './events'
import { enqueueAccountRefresh } from './queues'
import type { AccountView, AccountSnapshot, ModelView } from '../../shared/types'
const iso = (value: unknown): string | null => value == null ? null : new Date(value as string).toISOString()
export async function accountViews(rows: Record<string, any>[]): Promise<AccountView[]> {
  const pipeline = getRedis().pipeline()
  const now = Date.now()
  rows.forEach(row => pipeline.zcount(`ccm:gateway:leases:account:${row.id}`,now,'+inf'))
  const counts = rows.length ? await pipeline.exec() : []
  if(rows.length && (!counts || counts.some(result=>result[0])))throw new Error('Unable to read current account concurrency')
  return rows.map((row,index) => ({
    id: row.id, label: row.label, email: row.email, groupName: row.group_name, note: row.note,
    enabled: row.enabled, quotaPaused: !!row.quota_paused, quotaResumeAt: iso(row.quota_resume_at), status: row.status, maxConcurrency: row.max_concurrency,
    inFlight: Number(counts?.[index]?.[1] ?? 0), hasApiKey: !!row.api_key_ciphertext,
    snapshot: row.snapshot as AccountSnapshot | null, syncError: row.sync_error,
    lastSyncAt: iso(row.last_sync_at), lastUsedAt: iso(row.last_used_at), createdAt: iso(row.created_at)!,
  }))
}
export async function getAccount(id: string): Promise<AccountView | null> {
  const sql=getDb(), rows=await sql`SELECT * FROM managed_accounts WHERE id=${id}`
  if (!rows.length) return null
  const account=(await accountViews(rows))[0]!
  const models=await sql`SELECT * FROM account_models WHERE account_id=${id} ORDER BY model_id`
  return { ...account, observedModels: models.map(m=>({modelId:m.model_id,status:m.status,reason:m.reason,cooldownUntil:iso(m.cooldown_until),lastCheckedAt:iso(m.last_checked_at)!})) }
}
export async function listAccounts(input: { q?:string; status?:string; group?:string; page:number; pageSize:number }) {
  const sql=getDb(), pattern=`%${(input.q??'').replace(/[\\%_]/g,'\\$&')}%`
  const filter=sql`WHERE (${input.q??''}='' OR label ILIKE ${pattern} OR email ILIKE ${pattern})
    AND (${input.status??''}='' OR status=${input.status??''}) AND (${input.group??''}='' OR group_name=${input.group??''})`
  const [rows,count,groups]=await Promise.all([
    sql`SELECT * FROM managed_accounts ${filter} ORDER BY created_at DESC,id LIMIT ${input.pageSize} OFFSET ${(input.page-1)*input.pageSize}`,
    sql`SELECT count(*)::int AS total FROM managed_accounts ${filter}`,
    sql`SELECT DISTINCT group_name FROM managed_accounts WHERE group_name<>'' ORDER BY group_name`,
  ])
  return {items:await accountViews(rows),total:count[0]!.total,page:input.page,pageSize:input.pageSize,groups:groups.map(g=>g.group_name)}
}
export async function patchAccount(id:string, values: {label?:string;groupName?:string;note?:string;enabled?:boolean;maxConcurrency?:number}) {
  const sql=getDb(), updates: Record<string, string|number|boolean|Date|null|string[]>={updated_at:new Date()}
  for (const [key,column] of Object.entries({label:'label',groupName:'group_name',note:'note',maxConcurrency:'max_concurrency'})) {
    const value=values[key as keyof typeof values]
    if (value !== undefined) updates[column]=value
  }
  if (values.enabled === false) Object.assign(updates,{enabled:false,quota_paused:false,quota_resume_at:null,quota_pause_reasons:[]})
  const enable = values.enabled === true ? sql`,enabled=CASE WHEN quota_paused THEN false ELSE true END,quota_resume_at=CASE WHEN quota_paused THEN now() ELSE NULL END` : sql``
  const rows=await sql`UPDATE managed_accounts SET ${sql(updates)} ${enable} WHERE id=${id} RETURNING id`
  if (!rows.length) return null
  if (values.enabled === true) await enqueueAccountRefresh(id,{reason:'manual',force:true})
  await publishUpdate({type:'accounts',accountId:id})
  return getAccount(id)
}
export async function createPendingAccount(fingerprint:string,ciphertext:string,groupName?:string) {
  const settings=await getSettings(), sql=getDb(), id=randomUUID()
  const rows=await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext,group_name,max_concurrency)
    VALUES(${id},${fingerprint},${ciphertext},${groupName??''},${settings.defaultAccountConcurrency})
    ON CONFLICT(credential_fingerprint) DO UPDATE SET updated_at=managed_accounts.updated_at RETURNING *`
  return rows[0]!
}
export async function attachIdentity(pendingId:string,identity:AccountSnapshot['identity'],fingerprint:string,ciphertext:string,groupName?:string) {
  const sql=getDb()
  return sql.begin(async tx=> {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${identity.id},0))`
    const matches=await tx`SELECT * FROM managed_accounts WHERE upstream_user_id=${identity.id} FOR UPDATE`
    const existing=matches[0]
    if (existing && existing.id!==pendingId) {
      await tx`DELETE FROM managed_accounts WHERE id=${pendingId} AND upstream_user_id IS NULL`
      const rows=await tx`UPDATE managed_accounts SET credential_fingerprint=${fingerprint},cookie_ciphertext=${ciphertext},email=${identity.email},
        status='pending',sync_error=NULL,group_name=${groupName??existing.group_name},updated_at=now() WHERE id=${existing.id} RETURNING *`
      return {account:rows[0]!,updated:true}
    }
    const rows=await tx`UPDATE managed_accounts SET upstream_user_id=${identity.id},label=CASE WHEN label='' THEN ${identity.name} ELSE label END,
      email=${identity.email},cookie_ciphertext=${ciphertext},status='pending',sync_error=NULL,updated_at=now() WHERE id=${pendingId} RETURNING *`
    return {account:rows[0]!,updated:!!existing}
  })
}
export async function listModels(): Promise<{items:ModelView[];updatedAt:string|null}> {
  const sql=getDb()
  const rows=await sql`SELECT c.*,count(m.account_id) FILTER(WHERE m.status='allowed')::int AS allowed,
    count(m.account_id) FILTER(WHERE m.status='denied')::int AS denied,
    (SELECT count(*)::int FROM managed_accounts a WHERE NOT EXISTS (SELECT 1 FROM account_models known WHERE known.account_id=a.id AND known.model_id=c.model_id AND known.status IN ('allowed','denied'))) AS unknown
    FROM model_catalog c LEFT JOIN account_models m ON m.model_id=c.model_id GROUP BY c.model_id ORDER BY c.name,c.model_id`
  return {items:rows.map(r=>({id:r.model_id,name:r.name,observedAllowed:r.allowed,observedDenied:r.denied,unknownAccounts:r.unknown,updatedAt:iso(r.updated_at)!})),
    updatedAt:rows.length?new Date(Math.max(...rows.map(r=>new Date(r.updated_at).getTime()))).toISOString():null}
}