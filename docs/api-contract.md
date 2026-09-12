# Implementation contract

Node 24 / Nuxt 4, root owns package/config, infrastructure and auth.
Types are in shared/types.ts; DTOs use camelCase, DB uses snake_case.

## Admin API (session authentication; auth/session and auth/login are public)
- GET /api/auth/session -> { authenticated, username }
- POST /api/auth/login {username,password}; POST /api/auth/logout
- GET /api/dashboard -> DashboardView
- GET /api/accounts?q=&status=&group=&page=1&pageSize=50 -> {items:AccountView[],total,page,pageSize,groups:string[]}
- POST /api/accounts/import {text,groupName?} -> {jobId,accepted,rejected,duplicates}
- GET /api/jobs/:id -> JobView
- GET /api/accounts/:id -> AccountView
- PATCH /api/accounts/:id {label?,groupName?,note?,enabled?,maxConcurrency?} -> AccountView
- POST /api/accounts/actions {ids,action:'refresh'|'enable'|'disable'|'delete'} -> {ok:true,affected}
- GET /api/models -> {items:ModelView[],updatedAt:string|null}
- GET /api/service-keys -> {items:GatewayKeyView[]}; POST {name} -> {key:string,item:GatewayKeyView} (independent external service keys)
- PATCH /api/service-keys/:id {name?,enabled?} -> {ok:true}; DELETE /api/service-keys/:id -> {ok:true}
- GET /api/keys -> {items:GatewayKeyView[]}; POST {name} -> {key:string,item:GatewayKeyView}
- PATCH /api/keys/:id {name?,enabled?} -> {ok:true}; DELETE /api/keys/:id -> {ok:true}
- GET /api/logs?page=&pageSize=&model=&status= -> {items:RequestLogView[],total,page,pageSize}
- GET /api/logs/:id -> RequestLogView & {requestBody:unknown,responseBody:unknown,sessionId:string|null}
- GET /api/settings -> {settings:SystemSettings,kernel:{version,upstreamCommit,cliVersion}}
- PATCH /api/settings (SystemSettings) -> same shape as GET
- GET /api/events -> SSE "update" JSON {type,accountId?}; keepalive.

## External service API

All `/api/external/` routes require a dedicated `ccm_service_` key via `Authorization: Bearer KEY` or `x-api-key: KEY`. Admin sessions and model gateway keys do not authorize these routes. External service keys cannot authorize `/v1/` or admin API routes. Both key families can be created, disabled and revoked independently in the admin API keys page.

- POST /api/external/accounts {text|token|cookie,groupName?} -> HTTP 202 {jobId,accepted,rejected,duplicates}; exactly one credential field is required. Uses the same encrypted asynchronous import queue as the admin UI.
- GET /api/external/accounts?q=&status=&group=&page=1&pageSize=50 -> {items:AccountView[],total,page,pageSize,groups:string[]}; same validation and stored account data as the admin list, including nullable email. Includes disabled accounts unless filtered; no upstream refresh or credential export.
- GET /api/external/accounts/:id -> AccountView including email and observedModels; UUID validation and 404 for a missing account.
- GET /api/external/jobs/:id -> JobView (404 after the queue job expires).
- GET /api/external/pool -> DashboardView, using the same stored database and Redis state as the admin dashboard. `ready` counts enabled, successfully synced accounts with an API key and no exhausted quota in their stored snapshot; it does not guarantee model access or a free concurrency slot; `lastSyncAt` indicates the latest account sync, not that every account was refreshed then.

See [external-api.md](external-api.md) for request examples, limits and status semantics.

## Shared backend imports root provides
server/lib/config.ts: getConfig() -> {databaseUrl,redisUrl,encryptionKey,adminUsername,adminPassword,appUrl,kernelUrl}
server/lib/db.ts: getDb() -> postgres.Sql; closeDb()
server/lib/redis.ts: getRedis() -> ioredis.Redis; createRedisConnection() -> Redis; closeRedis()
server/lib/crypto.ts: encryptSecret(string), decryptSecret(string), fingerprint(string), hashGatewayKey(string)
server/lib/settings.ts (data agent): getSettings():Promise<SystemSettings>, saveSettings(SystemSettings)
server/lib/queues.ts (data agent): enqueueAccountRefresh(accountId,{reason?,force?}?), getImportQueue()
server/lib/events.ts (root): publishUpdate({type,accountId?})
server/lib/logs.ts (root): insertRequestLog(input) and pagination via SQL
server/lib/auth.ts (root): requireAdmin(event), authenticateGatewayKey(secret):Promise<{id,name}|null>, requireServiceKey(event), authenticateServiceKey(secret):Promise<{id,name}|null>

## DB schema contract (data agent owns SQL migration)
managed_accounts: id UUID, upstream_user_id TEXT UNIQUE, credential_fingerprint TEXT UNIQUE,
label TEXT, email TEXT NULL, cookie_ciphertext TEXT, api_key_ciphertext TEXT NULL, api_key_id TEXT NULL,
group_name TEXT DEFAULT '', note TEXT DEFAULT '', enabled BOOL, status TEXT (pending/ready/credential_expired/sync_error),
max_concurrency INT, snapshot JSONB NULL, sync_error TEXT NULL, last_sync_at TIMESTAMPTZ NULL,
last_used_at TIMESTAMPTZ NULL, created_at/updated_at TIMESTAMPTZ.
account_models: account_id UUID FK, model_id TEXT, status TEXT(allowed/denied/cooldown),
reason TEXT NULL, cooldown_until TIMESTAMPTZ NULL,last_checked_at TIMESTAMPTZ, PK(account_id,model_id).
model_catalog: model_id TEXT PK,name TEXT,metadata JSONB,updated_at TIMESTAMPTZ.
gateway_keys: id UUID,name TEXT,prefix TEXT,secret_hash TEXT UNIQUE,enabled BOOL,created_at,last_used_at NULL.
service_keys: same fields as gateway_keys, separate table for external service credentials (migration 002_service_keys.sql).
app_settings: id INT PK=1,value JSONB,updated_at.
request_logs: id UUID,key_id UUID NULL,account_id UUID NULL,model TEXT,protocol TEXT,
session_id TEXT NULL,status TEXT,http_status INT NULL,duration_ms INT,streaming BOOL,
usage JSONB NULL,error_message TEXT NULL,request_body JSONB NULL,response_body JSONB NULL,
response_truncated BOOL DEFAULT FALSE,created_at TIMESTAMPTZ.

## Gateway (gateway agent)
server/routes/v1/[...path].ts supports GET models and POST chat/completions,messages,responses.
Use own API keys, select account with Redis atomic global+per-account lease, affinity by client session headers/prompt_cache_key.
Respect actual MODEL_NOT_IN_PLAN independent of HTTP401. Unknown models can be attempted, observed denials excluded.
Never retry ambiguous execution failures or restart a stream. Preserve content and structured usage.
The root supplies auth/logging functions; data agent supplies queues/settings.
No test credentials in source, no public exposing PostgreSQL/Redis/core, no core automatic update.

- DashboardView.quota contains accountCount and fiveHour/weekly/monthly totals: used, cap, remaining, knownAccounts, unknownAccounts. Missing window data is excluded from totals and counted independently.
- AccountView exposes quotaPaused and quotaResumeAt. Manual disable cancels automatic recovery; enabling a quota-paused account requests an immediate refresh and keeps it paused until recovery is confirmed.
