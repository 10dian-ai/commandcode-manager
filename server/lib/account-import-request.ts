import { createError } from 'h3'
import { z } from 'zod'
import { validate } from './account-validation'
import { queueImport } from './queues'

const importBodySchema = z.object({
  text: z.string().min(1).max(2_000_000),
  groupName: z.string().trim().max(100).optional(),
}).strict()

const singleLine = (maximum: number) => z.string().min(1).max(maximum).refine(value => !/[\r\n]/.test(value), 'Provide a single line')
const externalImportBodySchema = z.object({
  text: z.string().min(1).max(2_000_000).optional(),
  token: singleLine(8192).optional(),
  cookie: singleLine(2_000_000).optional(),
  groupName: z.string().trim().max(100).optional(),
}).strict().refine(body => [body.text, body.token, body.cookie].filter(value => value !== undefined).length === 1, {
  message: 'Provide exactly one of text, token or cookie',
})

export async function submitAccountImport(input: unknown) {
  const body = validate(importBodySchema, input)
  if (body.text.split(/\r?\n/).length > 2000) throw createError({ statusCode: 400, statusMessage: 'Maximum 2000 lines per import' })
  return queueImport(body.text, body.groupName)
}

export async function submitExternalAccountImport(input: unknown) {
  const body = validate(externalImportBodySchema, input)
  return submitAccountImport({ text: body.text ?? body.token ?? body.cookie, groupName: body.groupName })
}
