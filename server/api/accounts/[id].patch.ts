import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import { z } from 'zod'
import { validate,accountIdSchema } from '../../lib/account-validation'
import { patchAccount } from '../../lib/accounts'
export default defineEventHandler(async event=>{
  const id=validate(accountIdSchema,getRouterParam(event,'id'))
  const body=validate(z.object({label:z.string().trim().min(1).max(200).optional(),groupName:z.string().trim().max(100).optional(),note:z.string().max(5000).optional(),enabled:z.boolean().optional(),maxConcurrency:z.number().int().min(1).max(100).optional()}).strict(),await readBody(event))
  const account=await patchAccount(id,body)
  if(!account)throw createError({statusCode:404,statusMessage:'Account not found'})
  return account
})