import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { submitExternalAccountImport } from '../../lib/account-import-request'

// The global admin middleware requires a separate service key for every /api/external/ request.
export default defineEventHandler(async event => {
  const result = await submitExternalAccountImport(await readBody(event))
  setResponseStatus(event, 202)
  return result
})
