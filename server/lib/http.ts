import { createError } from 'h3'
export function pagination(query: Record<string, unknown>) {
  const page = Math.max(1, Math.min(100000, Number.parseInt(String(query.page ?? '1')) || 1))
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(String(query.pageSize ?? '50')) || 50))
  return { page, pageSize, offset: (page - 1) * pageSize }
}
export function requireUuid(value: string | undefined) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw createError({ statusCode: 400, statusMessage: '无效的记录 ID' })
  return value
}
