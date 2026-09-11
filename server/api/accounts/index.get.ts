import { defineEventHandler, getQuery } from 'h3'
import { z } from 'zod'
import { validate } from '../../lib/account-validation'
import { listAccounts } from '../../lib/accounts'
export default defineEventHandler(event=>listAccounts(validate(z.object({
  q:z.string().max(200).optional(),status:z.enum(['','pending','ready','credential_expired','sync_error']).optional(),group:z.string().max(100).optional(),
  page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(200).default(50),
}),getQuery(event))))