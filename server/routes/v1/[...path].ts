import { defineEventHandler } from 'h3'
import { handleGateway } from '../../lib/gateway/handler'

export default defineEventHandler(handleGateway)