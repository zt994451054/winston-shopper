import { ShoppingError } from './errors.mjs';

export const DEFAULT_BRIDGE_ENDPOINT = 'http://127.0.0.1:19825';
export const EXTENSION_PROTOCOL = 'playwright-extension';
export const EXTENSION_INVENTORY_SCOPE = 'playwright_connected_pages';
export const BRIDGE_CAPABILITIES = Object.freeze(['tab_list', 'tab_new', 'tab_close', 'eval', 'snapshot', 'tab_show', 'hover', 'click', 'fill']);
const STATES = new Set(['starting', 'connecting', 'ready', 'disconnected', 'failed', 'stopping', 'stopped']);
const ERROR_CODES = new Set(['PLAYWRIGHT_CONNECT_FAILED', 'PLAYWRIGHT_TOKEN_MISSING', 'PLAYWRIGHT_TOKEN_ACCESS_FAILED',
  'PLAYWRIGHT_TOKEN_FILE_INVALID', 'PLAYWRIGHT_TOKEN_PERMISSIONS', 'PLAYWRIGHT_TOKEN_INVALID', 'MCP_PROTOCOL_INCOMPATIBLE',
  'MCP_PROTOCOL_ERROR', 'MCP_TIMEOUT', 'MCP_DISCONNECTED', 'MCP_REQUEST_FAILED', 'MCP_STOP_FAILED', 'EXTENSION_DISCONNECTED',
  'BACKEND_MISSING', 'SERVICE_START_FAILED', 'SERVICE_STOPPING', 'INVALID_RESPONSE']);

/** Recognize current and historical extension names without rewriting saved state.
 * @param {unknown} protocol @returns {boolean} Whether the name identifies an extension channel.
 */
export function isExtensionProtocol(protocol) {
  return protocol === EXTENSION_PROTOCOL || protocol === 'bb-browser-extension';
}

/** Reject live execution of a retired browser checkpoint while keeping its cache validators and local readers usable.
 * @param {object} task Validated checkpoint. @returns {void} @throws {ShoppingError} LEGACY_BROWSER_TASK.
 */
export function requireLiveTaskChannel(task) {
  if (task.browser_session === 'dedicated') throw new ShoppingError('LEGACY_BROWSER_TASK',
    'This task uses the retired dedicated Chrome channel. Its checkpoint and cached results were retained.',
    'Use task-status or report-export to read the saved results, or task-end to end the old round locally. No migration or browser connection was attempted.');
}

/** Validate and redact status metadata without issuing a browser command.
 * @param {unknown} value Untrusted HTTP status body. @returns {object} Safe current or historical metadata.
 * @throws {ShoppingError} INCOMPATIBLE_BRIDGE. Historical metadata is recognized but cannot authorize page commands.
 */
export function validateBridgeStatus(value) {
  const invalid = () => new ShoppingError('INCOMPATIBLE_BRIDGE', 'The endpoint does not report the supported Playwright service protocol.',
    'Use the Playwright service endpoint and run bridge-start explicitly. No legacy endpoint or CDP fallback was attempted.');
  if (typeof value?.running !== 'boolean' || typeof value.extensionConnected !== 'boolean') throw invalid();
  if (value.backend === undefined && value.protocol_version === undefined && value.state === undefined && value.running) {
    return { running: true, extensionConnected: value.extensionConnected, backend: 'bb-browser-extension' };
  }
  if (value.backend !== EXTENSION_PROTOCOL || value.protocol_version !== 1 || !STATES.has(value.state) ||
      typeof value.mcp_running !== 'boolean' || typeof value.instance_id !== 'string' ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.instance_id) ||
      !Array.isArray(value.capabilities) || value.capabilities.length > 32 ||
      value.capabilities.some(item => typeof item !== 'string' || !BRIDGE_CAPABILITIES.includes(item)) ||
      new Set(value.capabilities).size !== value.capabilities.length ||
      value.running !== (value.state !== 'stopped') || value.extensionConnected !== (value.state === 'ready')) throw invalid();
  return { running: value.running, extensionConnected: value.extensionConnected, backend: EXTENSION_PROTOCOL,
    protocol_version: 1, instance_id: value.instance_id, state: value.state, mcp_running: value.mcp_running,
    capabilities: [...value.capabilities], error_code: value.error_code === null ? null
      : ERROR_CODES.has(value.error_code) ? value.error_code : 'SERVICE_NOT_READY' };
}

/** Require an already connected, capable service; never start or reconnect it.
 * @param {object} status Validated metadata. @returns {object} The ready status.
 * @throws {ShoppingError} Legacy protocol, startup, disconnection, shutdown or missing-capability errors.
 */
export function requireReadyBridge(status) {
  if (status.backend !== EXTENSION_PROTOCOL) throw new ShoppingError('INCOMPATIBLE_BRIDGE',
    'A historical browser bridge was recognized. It is not the active Playwright channel.',
    'Start the Playwright service explicitly. Keep historical tasks and caches at their original endpoint.');
  if (status.state !== 'ready' || !status.mcp_running) {
    const code = status.error_code ?? ({ starting: 'SERVICE_STARTING', connecting: 'SERVICE_STARTING',
      stopping: 'SERVICE_STOPPING', stopped: 'SERVICE_STOPPED', disconnected: 'EXTENSION_DISCONNECTED' }[status.state] ?? 'SERVICE_NOT_READY');
    throw new ShoppingError(code, 'The original Playwright service is not ready. No connection or page command was attempted.',
      'Inspect the service, extension and fixed error code. Use bridge-start or bridge-stop explicitly after deciding how to proceed.');
  }
  if (!BRIDGE_CAPABILITIES.every(action => status.capabilities.includes(action))) throw new ShoppingError('UNSUPPORTED_CAPABILITY',
    'The Playwright service is missing required capabilities.', 'Check the pinned backend installation before explicitly restarting the service.');
  return status;
}
