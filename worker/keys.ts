import { getDb } from '../server/lib/db'
import { encryptSecret } from '../server/lib/crypto'
import { CommandCodeClient } from '../server/lib/commandcode'

// The upstream has no documented idempotency token. Durable intent + a stable random account name
// prevents blindly issuing another create request after a crash or an ambiguous response.
export async function ensureDedicatedKey(accountId:string,cookie:string,client:CommandCodeClient):Promise<void> {
  const sql=getDb(), rows=await sql`SELECT api_key_ciphertext FROM managed_accounts WHERE id=${accountId}`
  if (!rows.length || rows[0]!.api_key_ciphertext) return
  const name=`ccm-${accountId}`
  await sql`INSERT INTO key_creation_intents(account_id,key_name,state) VALUES(${accountId},${name},'prepared') ON CONFLICT(account_id) DO NOTHING`
  let intent=(await sql`SELECT * FROM key_creation_intents WHERE account_id=${accountId}`)[0]!
  if(intent.state==='blocked')throw new Error('KEY_CREATION_BLOCKED: 专用 Key 创建结果无法确认，请检查官方 Key 页面后重试')
  const keys=await client.listKeys(cookie), matches=keys.filter(k=>k.name===intent.key_name)
  if(matches.length>1 || (intent.state==='prepared' && matches.length)) {
    await sql`UPDATE key_creation_intents SET state='blocked',updated_at=now() WHERE account_id=${accountId}`
    throw new Error('KEY_NAME_CONFLICT: 专用 Key 名称冲突，已停止自动创建')
  }
  if(intent.state==='creating' || intent.state==='revoke_pending') {
    if (intent.state==='creating' && (!matches.length || intent.replacement_count>=1)) throw new Error('KEY_CREATION_UNCERTAIN: 上次创建结果未确认，已停止重复创建')
    const orphan=matches[0]
    if(orphan && intent.orphan_key_id && orphan.id!==intent.orphan_key_id)throw new Error('KEY_ID_CONFLICT: 已停止自动处理')
    if(orphan) {
      await sql`UPDATE key_creation_intents SET state='revoke_pending',orphan_key_id=${orphan.id},updated_at=now() WHERE account_id=${accountId}`
      await client.deleteKey(cookie,orphan.id)
      if((await client.listKeys(cookie)).some(k=>k.name===intent.key_name))throw new Error('KEY_REVOCATION_UNCONFIRMED: 等待确认专用 Key 已撤销')
    }
    await sql`UPDATE key_creation_intents SET state='prepared',orphan_key_id=NULL,replacement_count=replacement_count+1,updated_at=now() WHERE account_id=${accountId}`
    intent={...intent,state:'prepared'}
  }
  if(intent.state!=='prepared')throw new Error('KEY_STATE_INCONSISTENT: 专用 Key 状态需要检查')
  const claim=await sql`UPDATE key_creation_intents SET state='creating',updated_at=now() WHERE account_id=${accountId} AND state='prepared' RETURNING account_id`
  if(claim.length!==1)throw new Error('KEY_CREATION_BUSY: 其他任务已开始创建专用 Key')
  const created=await client.createKey(cookie,name)
  // Save the secret immediately. Key-list lookup is optional and cannot discard a successful create.
  await sql.begin(async tx=>{
    await tx`UPDATE managed_accounts SET api_key_ciphertext=${encryptSecret(created.apiKey)},api_key_id=${created.id},updated_at=now() WHERE id=${accountId}`
    await tx`UPDATE key_creation_intents SET state='complete',updated_at=now() WHERE account_id=${accountId}`
  })
  if(!created.id) {
    try {
      const key=(await client.listKeys(cookie)).find(k=>k.name===name)
      if(key)await sql`UPDATE managed_accounts SET api_key_id=${key.id} WHERE id=${accountId}`
    } catch { /* The encrypted key is durable; an optional ID lookup is not an authentication failure. */ }
  }
}