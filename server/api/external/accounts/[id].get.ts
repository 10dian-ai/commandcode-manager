import { createError, defineEventHandler, getRouterParam } from 'h3'
import { accountIdSchema, validate } from '../../../lib/account-validation'
import { getAccount } from '../../../lib/accounts'

export default defineEventHandler(async event => {
  const account = await getAccount(validate(accountIdSchema, getRouterParam(event, 'id')))
  if (!account) throw createError({ statusCode: 404, statusMessage: 'Account not found' })
  return account
})
