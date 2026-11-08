import http from 'node:http';
import path from 'node:path';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeEndpoint } from './bridge.mjs';
import { inspectPlaywrightBackend } from './setup.mjs';
import { CONNECT_FAILED_ACTION, readExtensionToken } from './playwright-config.mjs';
import { ShoppingError } from './errors.mjs';

const SKILL_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
const SERVICE_SCRIPT = fileURLToPath(new URL('../scripts/playwright-service.mjs', import.meta.url));
export const BRIDGE_RUNTIME_DIRECTORY = path.join(SKILL_DIRECTORY, '.runtime');
const FILES = { config: 'playwright-service-config.json', instance: 'bridge-service.json', lock: 'bridge-service.lock',
  recovery: 'bridge-service-recovery.lock', log: 'bridge-service.log' };
const STATES = new Set(['starting', 'connecting', 'ready', 'disconnected', 'failed', 'stopping', 'stopped']);
const PHASES = new Set(['launch_reserved', 'starting', 'ready', 'failed', 'stopped']);
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
// extension_disconnected (2026-11-08): a task once failed with the extension gone and the log could not say when it left.
const EVENTS = new Set(['launch_reserved', 'service_starting', 'service_ready', 'service_failed', 'service_stopping', 'service_stopped', 'extension_disconnected']);
const ERROR_CODES = new Set(['PLAYWRIGHT_CONNECT_FAILED', 'PLAYWRIGHT_TOKEN_MISSING', 'PLAYWRIGHT_TOKEN_ACCESS_FAILED',
  'PLAYWRIGHT_TOKEN_FILE_INVALID', 'PLAYWRIGHT_TOKEN_PERMISSIONS', 'PLAYWRIGHT_TOKEN_INVALID', 'MCP_PROTOCOL_INCOMPATIBLE',
  'MCP_PROTOCOL_ERROR', 'MCP_TIMEOUT', 'MCP_DISCONNECTED', 'MCP_REQUEST_FAILED', 'MCP_STOP_FAILED', 'EXTENSION_DISCONNECTED',
  'BRIDGE_PORT_IN_USE', 'BRIDGE_LISTEN_FAILED', 'BACKEND_MISSING', 'SERVICE_START_FAILED', 'SERVICE_STOPPING',
  'BRIDGE_START_FAILED', 'BRIDGE_BOOTSTRAP_FAILED', 'BRIDGE_LOG_FAILED']);

const failure = (code, message, nextAction) => new ShoppingError(code, message, nextAction);
const uncertain = () => failure('BRIDGE_START_UNCERTAIN', 'The saved service may still be running or starting. No second process was launched.',
  'Inspect the original service and its instance record before retrying. Do not clear task state or pacing data.');
const conflict = () => failure('BRIDGE_PORT_IN_USE', 'The selected endpoint belongs to another service or installation. Nothing was stopped or replaced.',
  'Check the intended endpoint and finish the existing service explicitly. No alternate port was selected.');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const pidOk = pid => Number.isSafeInteger(pid) && pid > 0;
const timeOk = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const codeOf = error => ERROR_CODES.has(error?.code) ? error.code : 'BRIDGE_START_FAILED';

function profileName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || ['.', '..'].includes(value) || /[\\/\u0000-\u001f\u007f]/.test(value)) {
    throw failure('PLAYWRIGHT_PROFILE_REQUIRED', 'Supply the Chrome profile directory name with bridge-start --profile NAME.',
      'Use the intended shopping profile directory name. No Chrome profiles were scanned.');
  }
  return value;
}

async function runtimeDirectory(directory, create = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw failure('BRIDGE_RUNTIME_INVALID', 'Use an absolute private service directory.');
  try {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (process.platform !== 'win32' && (metadata.mode & 0o7777) !== 0o700)) {
      throw failure('BRIDGE_RUNTIME_INVALID', 'The service directory must be a real directory with permissions 0700.');
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' && !create) return false;
    if (error instanceof ShoppingError) throw error;
    throw failure('BRIDGE_RUNTIME_INVALID', 'The private service directory is not accessible.');
  }
}

async function privateJson(directory, name) {
  let file;
  try {
    const filename = path.join(directory, name), before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16384 ||
        (process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600)) throw new Error();
    file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const metadata = await file.stat(), buffer = Buffer.alloc(16385);
    if (!metadata.isFile() || metadata.dev !== before.dev || metadata.ino !== before.ino ||
        (process.platform !== 'win32' && (metadata.mode & 0o7777) !== 0o600)) throw new Error();
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== metadata.size || bytesRead > 16384) throw new Error();
    return JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('INVALID_BRIDGE_RECORD', 'A private service record is invalid or unreadable. No browser process was selected.');
  } finally { await file?.close(); }
}

async function writeJson(directory, name, value) {
  const temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); await file.close(); file = null;
    await rename(temporary, path.join(directory, name));
  } catch { throw failure('BRIDGE_RECORD_WRITE_FAILED', 'The private service record could not be saved.'); }
  finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function validateInstance(value) {
  if (!exact(value, ['schema_version', 'instance_id', 'install_id', 'endpoint', 'profile', 'pid', 'launcher_pid', 'phase',
    'created_at', 'management_key', 'error_code']) || value.schema_version !== 1 || !UUID.test(value.instance_id) ||
    !HASH.test(value.install_id) || !HASH.test(value.management_key) || !PHASES.has(value.phase) ||
    !(value.pid === null || pidOk(value.pid)) || !pidOk(value.launcher_pid) || !timeOk(value.created_at) ||
    !(value.error_code === null || ERROR_CODES.has(value.error_code))) throw failure('INVALID_BRIDGE_RECORD', 'The saved service instance has an invalid format.');
  profileName(value.profile);
  if (normalizeEndpoint(value.endpoint) !== value.endpoint || new URL(value.endpoint).port === '0') {
    throw failure('INVALID_BRIDGE_RECORD', 'The saved service endpoint is invalid.');
  }
  return value;
}

async function readInstance(directory) {
  const record = await privateJson(directory, FILES.instance);
  return record === null ? null : validateInstance(record);
}

async function installId(directory) {
  return createHash('sha256').update(await realpath(directory)).digest('hex');
}

function matches(status, record) {
  return status?.running === true && typeof status.extensionConnected === 'boolean' && status.backend === 'playwright-extension' &&
    status.protocol_version === 1 && status.managed === true && status.instance_id === record.instance_id &&
    status.install_id === record.install_id && status.pid === record.pid && STATES.has(status.state);
}

function alive(pid) {
  if (!pidOk(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function request(endpoint, route, body) {
  const signal = AbortSignal.timeout(1000);
  try {
    return await new Promise((resolve, reject) => {
      const text = body === undefined ? undefined : JSON.stringify(body);
      const outgoing = http.request(`${endpoint}${route}`, { method: text ? 'POST' : 'GET', agent: false, signal,
        ...(text ? { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } } : {}) }, async response => {
        const chunks = []; let size = 0;
        try {
          if (response.statusCode !== 200) { response.destroy(); reject(conflict()); return; }
          for await (const chunk of response) {
            size += chunk.length;
            if (size > 8192) { response.destroy(); throw conflict(); }
            chunks.push(chunk);
          }
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch { reject(conflict()); }
      });
      outgoing.once('error', reject); outgoing.end(text);
    });
  } catch (error) {
    if (body === undefined && error.code === 'ECONNREFUSED') return null;
    if (error instanceof ShoppingError) throw error;
    throw failure(body === undefined ? 'BRIDGE_STATUS_UNCERTAIN' : 'BRIDGE_STOP_UNCERTAIN',
      'The service response was not confirmed. No request was retried and no process was killed.');
  }
}

/**
 * Write bounded JSON-line lifecycle events; never accept external messages, scripts, profiles or credentials as log text.
 * @param {string} directory Private runtime directory. @param {{maxBytes?: number, now?: Function}} [options] Test hooks.
 * @returns {{event: Function, flush: Function}} Serialized event writes and completion.
 * @throws {ShoppingError} BRIDGE_LOG_FAILED or INVALID_ARGUMENTS. The file is 0600 and limited to 64 KiB by default.
 */
export function createBridgeLogger(directory, { maxBytes = 65536, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 65536) throw failure('INVALID_ARGUMENTS', 'Use a bounded bridge log size.');
  let pending = Promise.resolve();
  return {
    event(event, errorCode = null) {
      if (!EVENTS.has(event)) return Promise.reject(failure('INVALID_ARGUMENTS', 'Only fixed lifecycle events may be logged.'));
      const line = `${JSON.stringify({ at: new Date(now()).toISOString(), event,
        ...(errorCode === null ? {} : { error_code: ERROR_CODES.has(errorCode) ? errorCode : 'BRIDGE_START_FAILED' }) })}\n`;
      const result = pending.catch(() => {}).then(async () => {
        let file;
        try {
          await runtimeDirectory(directory);
          file = await open(path.join(directory, FILES.log), constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
          const metadata = await file.stat();
          if (!metadata.isFile() || (process.platform !== 'win32' && (metadata.mode & 0o7777) !== 0o600)) throw new Error();
          const bytes = Buffer.from(line);
          let position = metadata.size;
          if (position + bytes.length > maxBytes) { await file.truncate(0); position = 0; }
          let written = 0;
          while (written < bytes.length) {
            const progress = await file.write(bytes, written, bytes.length - written, position + written);
            if (!progress.bytesWritten) throw new Error();
            written += progress.bytesWritten;
          }
          await file.truncate(position + bytes.length);
        } catch { throw failure('BRIDGE_LOG_FAILED', 'The private bridge log could not be written.'); }
        finally { await file?.close(); }
      });
      pending = result; return result;
    },
    flush() { return pending; },
  };
}

function dependencies(options) {
  return { now: Date.now, wait: delay, isAlive: alive, probe: endpoint => request(endpoint, '/status'),
    shutdown: (endpoint, body) => request(endpoint, '/shutdown', body), spawnProcess: spawn,
    inspectBackend: inspectPlaywrightBackend, readToken: readExtensionToken, timeoutMs: 90000, ...options };
}

async function publishLock(directory, owner) {
  const temporary = path.join(directory, `.${FILES.lock}-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(owner)); await file.close(); file = null;
    // A hard link publishes the complete owner record atomically without replacing another launcher's lock.
    await link(temporary, path.join(directory, FILES.lock));
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw failure('BRIDGE_LOCK_FAILED', 'The service launch lock could not be created.');
  } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function acquireLock(directory, endpoint, deps, deadline) {
  const filename = path.join(directory, FILES.lock), recovery = path.join(directory, FILES.recovery);
  let incomplete = 0;
  while (deps.now() < deadline) {
    if (await privateJson(directory, FILES.recovery)) throw failure('BRIDGE_LOCK_UNCERTAIN', 'A lock recovery is already reserved. Inspect it before retrying.');
    const candidate = { schema_version: 1, pid: process.pid, lock_id: randomUUID() };
    if (await publishLock(directory, candidate)) {
      return async () => {
        const current = await privateJson(directory, FILES.lock);
        if (current?.lock_id !== candidate.lock_id) throw failure('BRIDGE_LOCK_UNCERTAIN', 'The launch lock changed ownership. It was not removed.');
        await unlink(filename);
      };
    }
    let owner;
    try { owner = await privateJson(directory, FILES.lock); }
    catch (error) {
      // Another launcher may have created its exclusive file just before writing its owner record.
      if (error.code === 'INVALID_BRIDGE_RECORD' && ++incomplete <= 10) { await deps.wait(100); continue; }
      throw error;
    }
    // The previous owner may release the lock between our exclusive creation attempt and this read.
    if (owner === null) { await deps.wait(100); continue; }
    if (!exact(owner, ['schema_version', 'pid', 'lock_id']) || owner.schema_version !== 1 || !pidOk(owner.pid) || !UUID.test(owner.lock_id)) {
      throw failure('BRIDGE_LOCK_UNCERTAIN', 'The existing service lock is incomplete. It was not removed.');
    }
    if (deps.isAlive(owner.pid)) { await deps.wait(100); continue; }
    let guard;
    try { guard = await open(recovery, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') continue; throw failure('BRIDGE_LOCK_FAILED', 'The stale-lock recovery could not be reserved.'); }
    try {
      await guard.writeFile(JSON.stringify({ pid: process.pid }));
      const current = await privateJson(directory, FILES.lock);
      if (current?.lock_id !== owner.lock_id || deps.isAlive(owner.pid)) continue;
      const saved = await readInstance(directory);
      const status = await deps.probe(saved?.endpoint ?? endpoint);
      if (status && (!saved || !matches(status, saved))) throw conflict();
      if (!status && saved?.pid !== null && deps.isAlive(saved?.pid)) throw uncertain();
      await unlink(filename);
    } finally { await guard.close(); await unlink(recovery); }
  }
  throw failure('BRIDGE_START_IN_PROGRESS', 'Another bridge operation still holds the launch lock. No second process was started.');
}

function publicState(record, status, started) {
  return { ok: status?.state === 'ready', status: status?.state === 'ready' ? 'bridge_connected' : 'bridge_starting', started,
    endpoint: record.endpoint, pid: record.pid, instance_id: record.instance_id,
    running: status?.running ?? true, extensionConnected: status?.extensionConnected ?? false,
    state: status?.state ?? 'starting', next_action: status?.state === 'ready' ? 'Use the same endpoint for subsequent commands. Keep this service running while tasks are paused.'
      : 'Startup is not yet confirmed. Inspect this same instance; do not start a replacement or change task state.' };
}

async function waitReady(record, deps, deadline, childState, started) {
  while (deps.now() < deadline) {
    if (childState?.error) throw failure(childState.error, 'The first Playwright service startup failed. It was not retried.',
      childState.error === 'PLAYWRIGHT_CONNECT_FAILED' ? CONNECT_FAILED_ACTION
        : 'Inspect the profile, extension, local token and fixed error code before explicitly retrying startup.');
    const status = await deps.probe(record.endpoint);
    if (status) {
      if (!matches(status, record)) throw conflict();
      if (status.state === 'ready') return publicState(record, status, started);
      if (['failed', 'disconnected', 'stopping', 'stopped'].includes(status.state)) {
        throw failure(ERROR_CODES.has(status.error_code) ? status.error_code : 'EXTENSION_DISCONNECTED',
          'The saved Playwright service is not usable. No reconnection or replacement was attempted.', 'Inspect this instance and explicitly stop it before restarting.');
      }
    } else if (childState?.exited || !deps.isAlive(record.pid)) {
      throw failure('BRIDGE_START_FAILED', 'The saved service process exited before readiness was confirmed. It was not restarted.');
    }
    await deps.wait(100);
  }
  return publicState(record, null, started);
}

/**
 * Reuse or launch one persistent Playwright service. Task state and global browser discovery are never consulted.
 * @param {{endpoint: string, profile?: string, runtimeDirectory?: string, skillDirectory?: string}} options Local configuration.
 * @param {object} [hooks] Synthetic processes, metadata client, clock and dependency/token inspection for offline tests.
 * @returns {Promise<object>} Safe status without management credentials; startup timeout leaves the recorded child in place.
 * @throws {ShoppingError} Invalid records, profile, lock, dependency, port conflict or first startup failure.
 */
export async function startBridgeService({ endpoint, profile, runtimeDirectory: directory = BRIDGE_RUNTIME_DIRECTORY,
  skillDirectory = SKILL_DIRECTORY }, hooks = {}) {
  const origin = normalizeEndpoint(endpoint), deps = dependencies(hooks), deadline = deps.now() + deps.timeoutMs;
  if (new URL(origin).port === '0') throw failure('INVALID_ENDPOINT', 'Select a fixed service port greater than zero.');
  if (profile !== undefined) profileName(profile);
  await runtimeDirectory(directory, true);
  const release = await acquireLock(directory, origin, deps, deadline);
  let child, childState, record;
  try {
    const identity = await installId(skillDirectory), config = await privateJson(directory, FILES.config);
    if (config !== null && (!exact(config, ['schema_version', 'profile']) || config.schema_version !== 1)) {
      throw failure('INVALID_BRIDGE_RECORD', 'The saved Playwright profile configuration is invalid.');
    }
    if (config) profileName(config.profile);
    const selected = profileName(profile ?? config?.profile);
    const previous = await readInstance(directory);
    if (previous) {
      if (previous.install_id !== identity) throw conflict();
      const status = await deps.probe(previous.endpoint);
      if (status || deps.isAlive(previous.pid)) {
        if (previous.endpoint !== origin || previous.profile !== selected) throw failure('BRIDGE_CONFIG_MISMATCH', 'The existing instance uses another endpoint or profile. Stop it explicitly before changing configuration.');
        const result = await waitReady(previous, deps, deadline, null, false);
        if (result.ok && previous.phase !== 'ready') {
          previous.phase = 'ready'; previous.error_code = null;
          await writeJson(directory, FILES.instance, previous);
        }
        return result;
      }
    }
    if (await deps.probe(origin)) throw conflict();
    const backend = await deps.inspectBackend();
    if (!backend.installed || !backend.lock_verified) throw failure('BACKEND_MISSING', 'The pinned Playwright backend is not installed and verified.', 'Prepare the pinned runtime/playwright-backend installation before retrying bridge-start.');
    await deps.readToken(path.join(directory, 'pw-ext-token'));
    await writeJson(directory, FILES.config, { schema_version: 1, profile: selected });
    record = { schema_version: 1, instance_id: randomUUID(), install_id: identity, endpoint: origin, profile: selected,
      pid: null, launcher_pid: process.pid, phase: 'launch_reserved', created_at: new Date(deps.now()).toISOString(),
      management_key: randomBytes(32).toString('hex'), error_code: null };
    await writeJson(directory, FILES.instance, record);
    const log = createBridgeLogger(directory, { now: deps.now });
    await log.event('launch_reserved');
    childState = { error: null, exited: false };
    try {
      child = deps.spawnProcess(process.execPath, [SERVICE_SCRIPT, '--managed'], {
        cwd: skillDirectory, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      });
      child.on('error', () => { childState.error = 'BRIDGE_START_FAILED'; });
      child.on('exit', () => { childState.exited = true; });
      child.on('message', message => {
        if (message?.type === 'bridge_failed' && message.instance_id === record.instance_id) childState.error = codeOf({ code: message.error_code });
      });
      child.unref();
      if (!pidOk(child.pid)) throw failure('BRIDGE_START_FAILED', 'The owned service process did not confirm its PID.');
      record.pid = child.pid; record.phase = 'starting';
      await writeJson(directory, FILES.instance, record);
      await new Promise((resolve, reject) => {
        child.send({ type: 'bridge_bootstrap', runtime_directory: directory, instance_id: record.instance_id },
          error => error ? reject(failure('BRIDGE_BOOTSTRAP_FAILED', 'The owned service did not accept its startup identity.')) : resolve());
      });
    } catch (error) {
      record.phase = 'failed'; record.error_code = codeOf(error);
      await writeJson(directory, FILES.instance, record);
      if (record.pid === null || childState.exited) await log.event('service_failed', record.error_code);
      throw failure(record.error_code, 'The owned Playwright service could not be launched. No replacement was started.');
    }
    const result = await waitReady(record, deps, deadline, childState, true);
    if (result.ok) { record.phase = 'ready'; await writeJson(directory, FILES.instance, record); }
    return result;
  } catch (error) {
    if (record && (childState?.exited || childState?.error)) { record.phase = 'failed'; record.error_code = codeOf(error); await writeJson(directory, FILES.instance, record); }
    throw error;
  } finally {
    // The HTTP service, not the launching CLI or its IPC channel, owns the browser connection's lifetime.
    if (child?.connected) child.disconnect();
    await release();
  }
}

/**
 * Stop only the matching instance via its independent local credential. Never send an OS signal to a recorded PID.
 * @param {{endpoint: string, runtimeDirectory?: string, skillDirectory?: string}} options Original installation and endpoint.
 * @param {object} [hooks] Offline metadata/shutdown clients, clock and process-liveness checks.
 * @returns {Promise<object>} Confirmed stop; repeated calls are harmless. @throws {ShoppingError} Ownership or stop uncertainty.
 */
export async function stopBridgeService({ endpoint, runtimeDirectory: directory = BRIDGE_RUNTIME_DIRECTORY,
  skillDirectory = SKILL_DIRECTORY }, hooks = {}) {
  const origin = normalizeEndpoint(endpoint), deps = dependencies({ timeoutMs: 20000, ...hooks }), deadline = deps.now() + deps.timeoutMs;
  if (!await runtimeDirectory(directory)) {
    if (await deps.probe(origin)) throw conflict();
    return { ok: true, status: 'bridge_stopped', stopped: false, endpoint: origin };
  }
  const release = await acquireLock(directory, origin, deps, deadline);
  try {
    const record = await readInstance(directory), status = await deps.probe(origin);
    if (!record) {
      if (status) throw conflict();
      return { ok: true, status: 'bridge_stopped', stopped: false, endpoint: origin };
    }
    if (record.install_id !== await installId(skillDirectory) || record.endpoint !== origin || (status && !matches(status, record))) throw conflict();
    if (!status) {
      if (deps.isAlive(record.pid)) throw uncertain();
      if (record.phase !== 'stopped') { record.phase = 'stopped'; await writeJson(directory, FILES.instance, record); }
      return { ok: true, status: 'bridge_stopped', stopped: false, endpoint: origin };
    }
    const reply = await deps.shutdown(origin, { instance_id: record.instance_id, management_key: record.management_key });
    if (reply?.stopping !== true || reply.instance_id !== record.instance_id) throw failure('BRIDGE_STOP_UNCERTAIN', 'The stop acknowledgement did not match the original instance. Nothing was retried.');
    while (deps.now() < deadline) {
      let current;
      // A probe that lands while the server is closing can be reset instead of refused (2026-11-06 and 11-07 on long-running
      // services); that is not a verdict, so keep waiting for the refused port and the exited PID until the deadline.
      try { current = await deps.probe(origin); }
      catch (error) { if (error.code !== 'BRIDGE_STATUS_UNCERTAIN') throw error; await deps.wait(100); continue; }
      if (current && !matches(current, record)) throw conflict();
      if (!current && !deps.isAlive(record.pid)) {
        record.phase = 'stopped'; await writeJson(directory, FILES.instance, record);
        return { ok: true, status: 'bridge_stopped', stopped: true, endpoint: origin, instance_id: record.instance_id };
      }
      await deps.wait(100);
    }
    throw failure('BRIDGE_STOP_UNCERTAIN', 'The recorded service has not confirmed exit. No PID was killed and no stop request was resent.');
  } finally { await release(); }
}

/**
 * Validate the private bootstrap against the saved installation, instance and this child's PID before reading a token.
 * @param {object} message Parent IPC bootstrap (no credential values).
 * @param {{runtimeDirectory?: string, skillDirectory?: string, pid?: number}} [options] Defaults identify this installed child.
 * @returns {Promise<object>} Private instance record; must never be printed or included in public status.
 * @throws {ShoppingError} BRIDGE_BOOTSTRAP_FAILED or invalid private-state errors.
 */
export async function loadBridgeBootstrap(message, { runtimeDirectory: directory = BRIDGE_RUNTIME_DIRECTORY,
  skillDirectory = SKILL_DIRECTORY, pid = process.pid } = {}) {
  if (!exact(message, ['type', 'runtime_directory', 'instance_id']) || message.type !== 'bridge_bootstrap' || message.runtime_directory !== directory) {
    throw failure('BRIDGE_BOOTSTRAP_FAILED', 'The managed service bootstrap does not match this installation.');
  }
  await runtimeDirectory(directory);
  const record = await readInstance(directory);
  if (!record || record.instance_id !== message.instance_id || record.install_id !== await installId(skillDirectory) || record.pid !== pid || record.phase !== 'starting') {
    throw failure('BRIDGE_BOOTSTRAP_FAILED', 'The managed service identity was not committed for this process.');
  }
  return record;
}

/**
 * Run the detached entry after receiving only its committed identity over IPC. Credentials are read from the 0600 record.
 * @param {{startService: Function, channel?: object, bootstrapOptions?: object, bootstrapTimeoutMs?: number}} options
 *   startService is the normal Playwright startup function; hooks permit synthetic IPC and services in offline tests.
 * @returns {Promise<object>} The ready service; closing the launcher's IPC channel does not stop it.
 * @throws {ShoppingError} Bootstrap, log or first service startup failure, reported by a fixed IPC error code.
 */
export async function runManagedBridge({ startService, channel = process, bootstrapOptions = {}, bootstrapTimeoutMs = 5000 }) {
  let message, logger, running;
  const notify = value => { if (channel.connected) channel.send(value, () => {}); };
  try {
    message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(failure('BRIDGE_BOOTSTRAP_FAILED', 'The launcher did not provide a committed startup identity.')), bootstrapTimeoutMs);
      const onMessage = value => finish(null, value);
      const onDisconnect = () => finish(failure('BRIDGE_BOOTSTRAP_FAILED', 'The launcher disconnected before startup was committed.'));
      const finish = (error, value) => {
        clearTimeout(timer); channel.removeListener('message', onMessage); channel.removeListener('disconnect', onDisconnect);
        if (error) reject(error); else resolve(value);
      };
      channel.once('message', onMessage); channel.once('disconnect', onDisconnect);
    });
    const record = await loadBridgeBootstrap(message, bootstrapOptions);
    logger = createBridgeLogger(message.runtime_directory);
    await logger.event('service_starting');
    const url = new URL(record.endpoint);
    running = await startService({ port: Number(url.port || 80), host: url.hostname.replace(/[\[\]]/g, ''), profile: record.profile,
      tokenFile: path.join(message.runtime_directory, 'pw-ext-token'),
      management: { instanceId: record.instance_id, installId: record.install_id, key: record.management_key, pid: record.pid } }, {
      serviceOptions: { instanceId: record.instance_id, onDisconnected: () => { void logger.event('extension_disconnected').catch(() => {}); } },
      onStopping: () => logger.event('service_stopping'), onStopped: () => logger.event('service_stopped'),
      onStopError: error => { void logger.event('service_failed', codeOf(error)).catch(() => {}); notify({ type: 'bridge_failed', instance_id: record.instance_id, error_code: codeOf(error) }); },
    });
    await logger.event('service_ready');
    notify({ type: 'bridge_ready', instance_id: record.instance_id });
    return running;
  } catch (error) {
    const code = codeOf(error);
    try { await running?.stop(); } finally {
      if (logger) await logger.event('service_failed', code).catch(() => {});
      notify({ type: 'bridge_failed', instance_id: message?.instance_id, error_code: code });
    }
    throw error;
  }
}
