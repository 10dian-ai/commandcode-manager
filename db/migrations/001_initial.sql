CREATE TABLE IF NOT EXISTS managed_accounts (
 id UUID PRIMARY KEY, upstream_user_id TEXT UNIQUE, credential_fingerprint TEXT NOT NULL UNIQUE,
 label TEXT NOT NULL DEFAULT '', email TEXT, cookie_ciphertext TEXT NOT NULL, api_key_ciphertext TEXT, api_key_id TEXT,
 group_name TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT true,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','credential_expired','sync_error')),
 max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK(max_concurrency BETWEEN 1 AND 100), snapshot JSONB,
 sync_error TEXT, last_sync_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS managed_accounts_poll ON managed_accounts(status,last_sync_at);
CREATE TABLE IF NOT EXISTS account_models (
 account_id UUID NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE, model_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('allowed','denied','cooldown')), reason TEXT, cooldown_until TIMESTAMPTZ,
 last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(account_id,model_id)
);
CREATE TABLE IF NOT EXISTS model_catalog (model_id TEXT PRIMARY KEY,name TEXT NOT NULL,metadata JSONB NOT NULL DEFAULT '{}',updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS gateway_keys (id UUID PRIMARY KEY,name TEXT NOT NULL,prefix TEXT NOT NULL,secret_hash TEXT UNIQUE NOT NULL,enabled BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_used_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS app_settings (id INTEGER PRIMARY KEY CHECK(id=1),value JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS request_logs (
 id UUID PRIMARY KEY,key_id UUID REFERENCES gateway_keys(id) ON DELETE SET NULL,account_id UUID REFERENCES managed_accounts(id) ON DELETE SET NULL,
 model TEXT NOT NULL,protocol TEXT NOT NULL,session_id TEXT,status TEXT NOT NULL,http_status INTEGER,duration_ms INTEGER NOT NULL,
 streaming BOOLEAN NOT NULL DEFAULT false,usage JSONB,error_message TEXT,request_body JSONB,response_body JSONB,response_truncated BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_logs_created ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS request_logs_filter ON request_logs(model,status,created_at DESC);
CREATE INDEX IF NOT EXISTS request_logs_account ON request_logs(account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS key_creation_intents (
 account_id UUID PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE, key_name TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('prepared','creating','revoke_pending','complete','blocked')),
 orphan_key_id TEXT, replacement_count INTEGER NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);