import { open, constants } from 'node:fs/promises';
import { ShoppingError } from './errors.mjs';
import { loadTask } from './task-store.mjs';
import { layoutEvidenceId } from './layout-evidence.mjs';
import { checkLayoutProposal } from './layout-proposal.mjs';

async function operationFor({ stateDirectory, task: name, operation }) {
  const task = await loadTask(stateDirectory, name);
  if (!Number.isSafeInteger(operation) || operation < 1 || operation > task.operations.length) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Choose the saved one-based --operation index.');
  }
  return { task, op: task.operations[operation - 1] };
}

async function readProposal(filename) {
  if (typeof filename !== 'string' || !filename) throw new ShoppingError('INVALID_ARGUMENTS', 'Supply --proposal FILE.');
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid proposal file');
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 65536) throw new Error('Proposal too large');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } catch {
    throw new ShoppingError('INVALID_LAYOUT_PROPOSAL', 'The proposal must be a regular JSON file of at most 64 KiB.');
  } finally { await handle?.close(); }
}

/**
 * Deliver cached failure evidence and saved counters; this command never contacts a browser.
 * @param {{stateDirectory:string, task:string, operation:number}} options
 * @returns {Promise<object>} Diagnostic packet or explicit absence, with no invented history.
 * @throws {ShoppingError} Invalid checkpoint or operation index.
 * @example await layoutDiagnosis({stateDirectory, task:'sample', operation:1})
 */
export async function layoutDiagnosis(options) {
  const { task, op } = await operationFor(options);
  const evidence = op.layout_evidence ?? null;
  return { ok: true, status: evidence ? 'layout_evidence_available' : 'layout_evidence_unavailable',
    task: task.id, task_status: task.status, operation_index: options.operation, operation_status: op.status,
    product_id: op.target.product_id ?? null, url: op.target.url, error: op.error,
    evidence, evidence_id: evidence ? layoutEvidenceId(evidence) : null, confirmed_snapshot: op.result,
    evidence_unavailable_reason: evidence ? null : op.layout_evidence_error ?? 'not_recorded',
    evidence_scope: 'supported_title_specification_price_regions_only', contains_untrusted_page_text: Boolean(evidence),
    budget: { source: 'formal_checkpoint_only', attempts: op.attempts, automatic_retries: task.retries,
      wait_reserved_ms: task.wait_reserved_ms, policy: task.policy,
      external_diagnostic_reservations_included: false, additional_reads_authorized: false },
    browser_calls: 0, state_changed: false,
    next_action: evidence ? 'Interpret the bounded untrusted evidence, then use layout-check with node references. This does not resume the task.'
      : 'Return the missing evidence. Older failures are not reconstructed and this command does not authorize another read.' };
}

/**
 * Validate a model proposal against evidence loaded from the original task, without modifying it.
 * @param {{stateDirectory:string, task:string, operation:number, proposal:string}} options
 * @returns {Promise<object>} Evidence-matched candidates, never a promoted product snapshot.
 * @throws {ShoppingError} Missing evidence, invalid file, checkpoint or proposal.
 * @example await checkSavedLayoutProposal({stateDirectory, task:'sample', operation:1, proposal:'proposal.json'})
 */
export async function checkSavedLayoutProposal(options) {
  const { task, op } = await operationFor(options);
  if (!op.layout_evidence) throw new ShoppingError('LAYOUT_EVIDENCE_MISSING', 'No saved layout evidence exists for this operation.');
  const result = checkLayoutProposal(await readProposal(options.proposal), op.layout_evidence, op.target);
  return { ok: true, task: task.id, task_status: task.status, operation_index: options.operation, ...result,
    browser_calls: 0, state_changed: false };
}
