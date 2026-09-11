import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const base = 'https://api.commandcode.ai';
const kernelBase = 'http://127.0.0.1:13059';
const corePath = resolve('reference', 'commandcode-proxy-6217305', 'proxy.mjs');
let kernel = null;
let kernelStarted = false;
const kernelLogs = [];
const cookie = process.env.COMMANDCODE_TEST_COOKIE;
delete process.env.COMMANDCODE_TEST_COOKIE;
if (!cookie) throw new Error('Missing in-memory test Cookie');
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6);
const reportDir = resolve('artifacts', 'kernel-model-probes');
const reportPath = resolve(reportDir, runId + '.json');
const markdownPath = resolve(reportDir, runId + '.md');
const keyName = 'kernel-check-' + randomUUID().slice(0, 12);
let apiKey = null;
let keyId = null;
let createdKey = false;
let keyRevoked = false;
let models = [];
const results = [];
const report = {
  startedAt: new Date().toISOString(),
  apiBase: base,
  mode: 'Model generation requests sent through downloaded commandcode-proxy core on localhost',
  kernelBase,
  coreCommit: '621730578ff95b56a1df77e3dda3396cdfd2c585',
  catalogSource: base + '/provider/v1/models',
  catalogIsAccountPermissions: false,
  settings: { concurrency: 2, attemptsPerModel: 1, maxOutputTokens: 128, timeoutMs: 45000 },
  results
};
function safeMessage(value) {
  let message = String(value ?? '');
  if (apiKey) message = message.split(apiKey).join('[redacted]');
  message = message.split(cookie).join('[redacted]');
  return message.replace(/user_[a-zA-Z0-9_-]{12,}/g, '[redacted]').slice(0, 600);
}
async function request(path, { method = 'GET', body, credential = 'cookie', timeout = 25000, headers: extra = {} } = {}) {
  const headers = { Accept: 'application/json', ...extra };
  if (credential === 'cookie') { headers.Cookie = cookie; headers.Origin = 'https://commandcode.ai'; }
  if (credential === 'api-key') headers.Authorization = 'Bearer ' + apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const targetBase = credential === 'api-key' ? kernelBase : base;
  const response = await fetch(targetBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeout) });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = null; }
  return { status: response.status, data, raw };
}
function creditSnapshot(response) {
  const credits = response.data?.credits;
  return {
    httpStatus: response.status,
    monthlyCredits: credits?.monthlyCredits ?? null,
    purchasedCredits: credits?.purchasedCredits ?? null,
    windowLimits: response.data?.windowLimits ?? null
  };
}
function usageSnapshot(response) {
  const body = response.data;
  const fields = ['totalCount', 'totalCost', 'totalTokensIn', 'totalTokensOut', 'totalTokens', 'totalCredits', 'totalMonthlyCredits', 'totalPurchasedCredits', 'periodBasis'];
  return { httpStatus: response.status, ...Object.fromEntries(fields.filter(f => body?.[f] !== undefined).map(f => [f, body[f]])) };
}
function findCreatedKey(value) {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value) && value.name === keyName && typeof value.id === 'string') return value.id;
  for (const entry of Object.values(value)) { const found = findCreatedKey(entry); if (found) return found; }
  return null;
}
async function resolveKeyId() {
  const response = await request('/internal/api-keys/list', { method: 'POST', body: { orgId: null } });
  if (response.status < 200 || response.status >= 300) throw new Error('Temporary key lookup failed, HTTP ' + response.status);
  return findCreatedKey(response.data);
}
async function persist() {
  report.updatedAt = new Date().toISOString();
  report.totalModels = models.length;
  report.attemptedModels = results.length;
  report.outcomes = results.reduce((all, result) => { all[result.outcome] = (all[result.outcome] ?? 0) + 1; return all; }, {});
  report.temporaryKey = { created: createdKey, revoked: keyRevoked };
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
async function probe(model) {
  const anthropic = /^(?:anthropic\/)?claude/i.test(model);
  const endpoint = anthropic ? '/v1/messages' : '/v1/chat/completions';
  const body = anthropic
    ? { model, max_tokens: 128, messages: [{ role: 'user', content: 'Reply exactly OK.' }] }
    : { model, max_tokens: 128, messages: [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Reply exactly OK.' }] };
  const started = Date.now();
  let entry = { model, endpoint, startedAt: new Date().toISOString() };
  try {
    const response = await request(endpoint, { method: 'POST', body, credential: 'api-key', timeout: 45000, headers: anthropic ? { 'anthropic-version': '2023-06-01' } : {} });
    entry.httpStatus = response.status;
    if (response.status >= 200 && response.status < 300) {
      entry.outcome = 'success';
      entry.usage = response.data?.usage ?? null;
      entry.output = safeMessage(anthropic
        ? (response.data?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('')
        : response.data?.choices?.[0]?.message?.content ?? '');
      entry.finishReason = response.data?.stop_reason ?? response.data?.choices?.[0]?.finish_reason ?? null;
      const message = response.data?.choices?.[0]?.message;
      const reasoning = anthropic
        ? (response.data?.content ?? []).filter(x => x.type === 'thinking').map(x => x.thinking ?? '').join('')
        : message?.reasoning_content ?? '';
      entry.textLength = entry.output.length;
      entry.reasoningLength = typeof reasoning === 'string' ? reasoning.length : 0;
      entry.toolCallCount = anthropic
        ? (response.data?.content ?? []).filter(x => x.type === 'tool_use').length
        : Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
      if (!entry.textLength && !entry.toolCallCount) entry.outcome = entry.reasoningLength ? 'reasoning_only' : 'empty_response';
      else if (entry.finishReason === 'length' || entry.finishReason === 'max_tokens') entry.outcome = 'generated_but_truncated';
    } else {
      const error = response.data?.error;
      entry.errorCode = error?.code ?? response.data?.code ?? null;
      entry.errorType = error?.type ?? response.data?.type ?? null;
      entry.message = safeMessage(error?.message ?? response.data?.message ?? (typeof error === 'string' ? error : response.raw));
      entry.outcome = response.status === 429 && /zero output|empty response/i.test(entry.message) ? 'empty_output_or_usage_missing'
        : response.status === 429 && /timeout|timed out/i.test(entry.message) ? 'timeout'
        : entry.errorCode === 'upgrade_required' || /MODEL_NOT_IN_PLAN/.test(entry.message) || /go plan|upgrade.*(?:plan|api)|api access.*(?:plan|upgrade)/i.test(entry.message)
        ? 'plan_restricted'
        : response.status === 401 ? 'authentication_error'
        : response.status === 429 ? 'rate_limited'
        : response.status === 400 || response.status === 422 ? 'request_rejected'
        : response.status === 403 ? 'permission_denied' : 'upstream_error';
    }
  } catch (error) {
    entry.outcome = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'network_error';
    entry.message = safeMessage(error.message);
  }
  entry.elapsedMs = Date.now() - started;
  results.push(entry);
  if (results.length % 5 === 0 || results.length === models.length) {
    await persist();
    console.log(JSON.stringify({ progress: results.length + '/' + models.length, outcomes: report.outcomes }));
  }
}

async function startKernel() {
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Kernel startup timed out')), 10000);
    let bootText = '';
    kernel = spawn(process.execPath, [corePath], {
      cwd: resolve('reference', 'commandcode-proxy-6217305'),
      windowsHide: true,
      env: { ...process.env, HOST: '127.0.0.1', PORT: '13059', CC_MAX_INFLIGHT: '2', CC_MAX_BODY_MB: '1', LOG_FILE: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const collect = chunk => {
      const text = safeMessage(chunk.toString());
      kernelLogs.push(text);
      if (kernelLogs.length > 80) kernelLogs.shift();
    };
    kernel.stdout.on('data', chunk => {
      collect(chunk);
      bootText += chunk.toString();
      if (!kernelStarted && bootText.includes('CC Proxy started')) {
        kernelStarted = true;
        clearTimeout(timer);
        done();
      }
      if (bootText.length > 12000) bootText = bootText.slice(-12000);
    });
    kernel.stderr.on('data', collect);
    kernel.once('error', error => { clearTimeout(timer); fail(error); });
    kernel.once('exit', code => {
      if (!kernelStarted) { clearTimeout(timer); fail(new Error('Kernel exited during startup, code ' + code)); }
    });
  });
  const health = await fetch(kernelBase + '/health', { signal: AbortSignal.timeout(3000) });
  if (!health.ok || (await health.text()).trim() !== 'OK') throw new Error('Kernel health check failed');
  report.kernelStarted = true;
  console.log(JSON.stringify({ stage: 'kernel_ready', url: kernelBase }));
}
async function stopKernel() {
  if (!kernel || kernel.exitCode !== null) return;
  await new Promise(resolveStop => {
    const timer = setTimeout(() => { kernel.kill('SIGKILL'); resolveStop(); }, 3000);
    kernel.once('exit', () => { clearTimeout(timer); resolveStop(); });
    kernel.kill('SIGTERM');
  });
}

try {
  const session = await request('/auth/get-session');
  if (!session.data?.user || !session.data?.session) throw new Error('Test account session is not authenticated');
  const catalog = await request('/provider/v1/models', { credential: 'none' });
  if (catalog.status !== 200 || !Array.isArray(catalog.data?.data)) throw new Error('Model catalog could not be fetched');
  models = [...new Set(catalog.data.data.map(x => x.id).filter(x => typeof x === 'string'))];
  report.catalogFetchedAt = new Date().toISOString();
  report.beforeCredits = creditSnapshot(await request('/internal/billing/credits'));
  report.beforeUsage = usageSnapshot(await request('/internal/usage/summary'));
  const creation = await request('/internal/api-keys/create', { method: 'POST', body: { orgId: null, name: keyName, description: 'Temporary one-request-per-model verification; revoked after test' } });
  if (creation.status < 200 || creation.status >= 300) throw new Error('Temporary API key creation failed: HTTP ' + creation.status + ' ' + safeMessage(creation.data?.message ?? creation.data?.error?.message ?? ''));
  createdKey = true;
  apiKey = typeof creation.data?.apiKey === 'string' ? creation.data.apiKey : null;
  if (!apiKey) throw new Error('API key creation returned an unrecognized credential shape');
  keyId = await resolveKeyId();
  if (!keyId) throw new Error('Created temporary key could not be identified for cleanup');
  await startKernel();
  console.log(JSON.stringify({ stage: 'running', models: models.length, concurrency: 2, maxOutputTokens: 128 }));
  let next = 0;
  const worker = async () => { while (next < models.length) { const model = models[next++]; await probe(model); } };
  await Promise.all([worker(), worker()]);
  report.afterCredits = creditSnapshot(await request('/internal/billing/credits'));
  report.afterUsage = usageSnapshot(await request('/internal/usage/summary'));
} catch (error) {
  report.runError = safeMessage(error.message);
  console.log(JSON.stringify({ stage: 'error', message: report.runError }));
} finally {
  await stopKernel();
  report.kernelStopped = !kernel || kernel.exitCode !== null || kernel.signalCode !== null;
  report.kernelLogTail = kernelLogs.map(safeMessage);
  if (createdKey) {
    try {
      keyId ??= await resolveKeyId();
      if (keyId) {
        const removed = await request('/internal/api-keys/delete', { method: 'POST', body: { orgId: null, apiKeyId: keyId } });
        if (removed.status >= 200 && removed.status < 300) {
          keyRevoked = (await resolveKeyId()) === null;
        }
        if (!keyRevoked) report.cleanupError = 'Temporary key revocation was not confirmed';
      } else report.cleanupError = 'Temporary key ID could not be resolved for cleanup';
    } catch (error) { report.cleanupError = safeMessage(error.message); }
  }
  report.finishedAt = new Date().toISOString();
  await persist();
  const escapeCell = x => String(x ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  const lines = [
    '# commandcode-proxy kernel model probe', '',
    'Generation requests were sent to the downloaded fixed core at localhost. The catalog and account administration were read from the official website APIs.', '',
    '- Catalog models: ' + models.length,
    '- Attempted: ' + results.length,
    '- Outcomes: ' + JSON.stringify(report.outcomes),
    '- Temporary test key revoked: ' + keyRevoked,
    ...(report.runError ? ['- Run error: ' + report.runError] : []),
    ...(report.cleanupError ? ['- Cleanup issue: ' + report.cleanupError] : []),
    '', '| Model | HTTP | Outcome | Error code | Message / output |', '| --- | --- | --- | --- | --- |',
    ...results.map(r => '| ' + [r.model, r.httpStatus, r.outcome, r.errorCode, r.message ?? r.output].map(escapeCell).join(' | ') + ' |'), ''
  ];
  await writeFile(markdownPath, lines.join('\n'));
  console.log(JSON.stringify({ stage: 'complete', attempted: results.length, models: models.length, outcomes: report.outcomes, temporaryKeyRevoked: keyRevoked, kernelStopped: report.kernelStopped, reportPath, markdownPath, cleanupError: report.cleanupError ?? null }));
  apiKey = null;
}
