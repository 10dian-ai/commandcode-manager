import { defineEventHandler,readBody } from 'h3'
import { z } from 'zod'
import { validate } from '../../lib/account-validation'
import { getDb } from '../../lib/db'
import { enqueueAccountRefresh } from '../../lib/queues'
import { publishUpdate } from '../../lib/events'
export default defineEventHandler(async event=>{
  const {ids,action}=validate(z.object({ids:z.array(z.string().uuid()).min(1).max(2000),action:z.enum(['refresh','enable','disable','delete'])}).strict(),await readBody(event))
  const sql=getDb(),unique=[...new Set(ids)]
  let affected=0
  if(action==='refresh') {
    const rows=await sql`SELECT id FROM managed_accounts WHERE id IN ${sql(unique)}`
    for(const row of rows)await enqueueAccountRefresh(row.id,{reason:'manual',force:true})
    affected=rows.length
  } else if(action==='delete') {
    // Removing a managed account removes local encrypted credentials. Existing upstream keys are not revoked implicitly.
    const rows=await sql`DELETE FROM managed_accounts WHERE id IN ${sql(unique)} RETURNING id`
    affected=rows.length
  } else {
    const rows=action==='disable'
      ? await sql`UPDATE managed_accounts SET enabled=false,quota_paused=false,quota_resume_at=NULL,quota_pause_reasons='{}',updated_at=now() WHERE id IN ${sql(unique)} RETURNING id`
      : await sql`UPDATE managed_accounts SET enabled=CASE WHEN quota_paused THEN false ELSE true END,
        quota_resume_at=CASE WHEN quota_paused THEN now() ELSE NULL END,updated_at=now() WHERE id IN ${sql(unique)} RETURNING id`
    if(action==='enable')for(const row of rows)await enqueueAccountRefresh(row.id,{reason:'manual',force:true})
    affected=rows.length
  }
  await publishUpdate({type:'accounts'})
  return {ok:true,affected}
})