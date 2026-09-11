import { randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import { migrate } from '../server/lib/migrations'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = `ccm_test_${randomUUID().replaceAll('-', '')}`

// Integration only: never falls back to DATABASE_URL or the application's configured database.
describe.skipIf(!databaseUrl)('PostgreSQL account schema integration', () => {
  let admin: Sql | undefined
  let sql: Sql
  let created = false
  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    created = true
    sql = postgres(databaseUrl!, {
      max: 1, connect_timeout: 5, onnotice: () => {},
      connection: { search_path: schema, application_name: 'ccm-isolated-integration-test' },
    })
    const current = await sql`SELECT current_schema() AS schema`
    expect(current[0]?.schema).toBe(schema)
    await migrate(sql)
  }, 30_000)
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 })
    if (admin) {
      try {
        // Only remove the random schema created by this exact test run.
        if (created && /^ccm_test_[a-f0-9]{32}$/.test(schema)) await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      } finally { await admin.end({ timeout: 5 }) }
    }
  }, 30_000)

  it('reapplies migrations without deleting data or duplicating version records', async () => {
    const id = randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext,label)
      VALUES(${id},${randomUUID()},'encrypted-test-cookie','preserved')`
    const before = await sql`SELECT name,applied_at FROM schema_migrations ORDER BY name`
    expect(before.length).toBeGreaterThan(0)
    await migrate(sql)
    await migrate(sql)
    const after = await sql`SELECT name,applied_at FROM schema_migrations ORDER BY name`
    expect([...after]).toEqual([...before])
    const accounts = await sql`SELECT label FROM managed_accounts WHERE id=${id}`
    expect(accounts[0]?.label).toBe('preserved')
    const tables = await sql`SELECT table_schema FROM information_schema.tables WHERE table_schema=${schema}`
    expect(tables.length).toBeGreaterThanOrEqual(8)
  })

  it('enforces independent upstream identity and credential fingerprint uniqueness', async () => {
    const upstreamId = `user-${randomUUID()}`, fingerprint = randomUUID()
    await sql`INSERT INTO managed_accounts(id,upstream_user_id,credential_fingerprint,cookie_ciphertext)
      VALUES(${randomUUID()},${upstreamId},${fingerprint},'encrypted-test-cookie')`
    await expect(sql`INSERT INTO managed_accounts(id,upstream_user_id,credential_fingerprint,cookie_ciphertext)
      VALUES(${randomUUID()},${upstreamId},${randomUUID()},'encrypted-test-cookie')`).rejects.toMatchObject({ code: '23505' })
    await expect(sql`INSERT INTO managed_accounts(id,upstream_user_id,credential_fingerprint,cookie_ciphertext)
      VALUES(${randomUUID()},${`other-${randomUUID()}`},${fingerprint},'encrypted-test-cookie')`).rejects.toMatchObject({ code: '23505' })
  })

  it('cascades account-owned model/key state while preserving request content and nulling deleted references', async () => {
    const accountId = randomUUID(), gatewayKeyId = randomUUID(), logId = randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext)
      VALUES(${accountId},${randomUUID()},'encrypted-test-cookie')`
    await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash)
      VALUES(${gatewayKeyId},'test','test-prefix',${randomUUID()})`
    await sql`INSERT INTO account_models(account_id,model_id,status,reason)
      VALUES(${accountId},'test/model','denied','MODEL_NOT_IN_PLAN')`
    await sql`INSERT INTO key_creation_intents(account_id,key_name,state)
      VALUES(${accountId},${`ccm-${accountId}`},'complete')`
    await sql`INSERT INTO request_logs(id,key_id,account_id,model,protocol,status,http_status,duration_ms,request_body,response_body)
      VALUES(${logId},${gatewayKeyId},${accountId},'test/model','chat/completions','success',200,42,
      ${sql.json({ messages: [{ role: 'user', content: 'isolated test request' }] })},
      ${sql.json({ choices: [{ message: { content: 'isolated test response' } }] })})`
    await sql`DELETE FROM managed_accounts WHERE id=${accountId}`
    expect((await sql`SELECT * FROM account_models WHERE account_id=${accountId}`).length).toBe(0)
    expect((await sql`SELECT * FROM key_creation_intents WHERE account_id=${accountId}`).length).toBe(0)
    await sql`DELETE FROM gateway_keys WHERE id=${gatewayKeyId}`
    const logs = await sql`SELECT account_id,key_id,request_body,response_body FROM request_logs WHERE id=${logId}`
    expect(logs).toHaveLength(1)
    expect(logs[0]?.account_id).toBeNull()
    expect(logs[0]?.key_id).toBeNull()
    expect(logs[0]?.request_body.messages[0].content).toBe('isolated test request')
    expect(logs[0]?.response_body.choices[0].message.content).toBe('isolated test response')
    await expect(sql`INSERT INTO account_models(account_id,model_id,status)
      VALUES(${accountId},'test/model','allowed')`).rejects.toMatchObject({ code: '23503' })
  })
})