import { defineEventHandler, readBody, createError } from 'h3'
import { z } from 'zod'
import { validate } from '../../lib/account-validation'
import { queueImport } from '../../lib/queues'
export default defineEventHandler(async event=>{
  const body=validate(z.object({text:z.string().min(1).max(2_000_000),groupName:z.string().trim().max(100).optional()}).strict(),await readBody(event))
  if(body.text.split(/\r?\n/).length>2000)throw createError({statusCode:400,statusMessage:'Maximum 2000 lines per import'})
  return queueImport(body.text,body.groupName)
})