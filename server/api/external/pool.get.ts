import { defineEventHandler } from 'h3'
import { getDashboardView } from '../../lib/dashboard'

export default defineEventHandler(() => getDashboardView())
