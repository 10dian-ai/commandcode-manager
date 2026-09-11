import { defineEventHandler } from 'h3'
import { listModels } from '../lib/accounts'
export default defineEventHandler(()=>listModels())