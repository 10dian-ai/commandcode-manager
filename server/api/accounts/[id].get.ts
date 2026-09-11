import { defineEventHandler, getRouterParam, createError } from 'h3'
import { validate,accountIdSchema } from '../../lib/account-validation'
import { getAccount } from '../../lib/accounts'
export default defineEventHandler(async event=>{
  const account=await getAccount(validate(accountIdSchema,getRouterParam(event,'id')))
  if(!account)throw createError({statusCode:404,statusMessage:'Account not found'})
  return account
})