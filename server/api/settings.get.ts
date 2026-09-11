import { defineEventHandler } from 'h3'
import { getSettings } from '../lib/settings'
export const KERNEL_INFO = { version: '0.1.0', upstreamCommit: '621730578ff95b56a1df77e3dda3396cdfd2c585', cliVersion: '1.53.0' }
export default defineEventHandler(async () => ({ settings: await getSettings(), kernel: KERNEL_INFO }))
