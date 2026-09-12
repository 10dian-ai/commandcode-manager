import { defineEventHandler, readBody } from 'h3'
import { submitAccountImport } from '../../lib/account-import-request'
export default defineEventHandler(async event=>{
  return submitAccountImport(await readBody(event))
})
