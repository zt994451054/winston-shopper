import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Capture the checkpoint visible when a synthetic server receives tab_show; assertions run outside best-effort display.
 * @param {object} body Command envelope. @param {string} stateDirectory Synthetic state directory.
 * @param {string} task Task name. @param {object[]} records Display observations.
 * @returns {Promise<{visible: boolean}>} A synthetic successful display acknowledgement.
 */
export async function recordPausedDisplay(body, stateDirectory, task, records) {
  const record = { command: body, checkpoint: null, read_error: null };
  records.push(record);
  try { record.checkpoint = JSON.parse(await readFile(path.join(stateDirectory, 'tasks', `${task}.json`), 'utf8')); }
  catch { record.read_error = 'CHECKPOINT_UNREADABLE'; }
  return { visible: true };
}

/** Assert exactly one display per expected committed pause without adding it to the ordinary-command allowlist.
 * @param {object[]} records Captured display observations.
 * @param {Array<{tabId: number, status: string, code: string}>} expected Expected pauses in order.
 * @returns {void} @throws {assert.AssertionError} A display was early, duplicated, misdirected or unexpected.
 */
export function assertPausedDisplays(records, expected) {
  assert.equal(records.length, expected.length);
  for (const [index, { tabId, status, code }] of expected.entries()) {
    const { command, checkpoint, read_error: readError } = records[index];
    assert.equal(readError, null);
    assert.deepEqual(Object.keys(command).sort(), ['action', 'id', 'tabId']);
    assert.equal(command.action, 'tab_show');
    assert.equal(command.tabId, tabId);
    assert.equal(checkpoint.status, status);
    assert.equal(checkpoint.operations[0].status, 'pending');
    assert.equal(checkpoint.operations[0].tab_id, tabId);
    assert.equal(checkpoint.operations[0].error.code, code);
  }
}
