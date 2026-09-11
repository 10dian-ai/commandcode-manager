import { defineEventHandler,getRouterParam,createError } from 'h3'
import { validate,accountIdSchema } from '../../lib/account-validation'
import { getImportQueue } from '../../lib/queues'
import type { JobView,ImportResult } from '../../../shared/types'
export default defineEventHandler(async (event):Promise<JobView>=>{
  const id=validate(accountIdSchema,getRouterParam(event,'id')),job=await getImportQueue().getJob(id)
  if(!job)throw createError({statusCode:404,statusMessage:'Job not found or expired'})
  const state=await job.getState(),progress=typeof job.progress==='object'?job.progress:{processed:0,total:job.data.entries.length}
  return {id,status:state,progress:progress as JobView['progress'],result:state==='completed'?job.returnvalue as ImportResult:null,error:state==='failed'?'导入任务中断，请重试；已完成的账号已保留':null}
})