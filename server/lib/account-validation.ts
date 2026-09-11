import { createError } from 'h3'
import { z } from 'zod'
export function validate<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value)
  if(!result.success)throw createError({statusCode:400,statusMessage:'Invalid request',data:{issues:result.error.issues.map(i=>({path:i.path,message:i.message}))}})
  return result.data
}
export const accountIdSchema=z.string().uuid()