import { defineEventHandler, getRouterParam } from 'h3'
import { getImportJobView } from '../../../lib/import-job'

export default defineEventHandler(event => getImportJobView(getRouterParam(event, 'id')))
