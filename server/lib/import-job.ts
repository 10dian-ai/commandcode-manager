import { createError } from 'h3'
import type { ImportResult, JobView } from '../../shared/types'
import { accountIdSchema, validate } from './account-validation'
import { getImportQueue } from './queues'

export async function getImportJobView(input: unknown): Promise<JobView> {
  const id = validate(accountIdSchema, input)
  const job = await getImportQueue().getJob(id)
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Job not found or expired' })
  const state = await job.getState()
  const progress = typeof job.progress === 'object' ? job.progress : { processed: 0, total: job.data.entries.length }
  return {
    id, status: state, progress: progress as JobView['progress'],
    result: state === 'completed' ? job.returnvalue as ImportResult : null,
    error: state === 'failed' ? '导入任务中断，请重试；已完成的账号已保留' : null,
  }
}
