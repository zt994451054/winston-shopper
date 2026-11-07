import { rawDetails } from './detail-fixture.mjs';
import { collectDescriptionText } from '../lib/description-dom.mjs';

/** @param {object} options Synthetic entry/text options. @returns {object} Page response without customer information. @example rawDescription({expanded: true}); */
export function rawDescription({ expanded = false, linked = true, present = true, text = 'Expanded body text', clipped = false } = {}) {
  const snapshot = rawDetails();
  snapshot.details.description.text = expanded ? text : '';
  snapshot.details.description.observation = { ...collectDescriptionText(null, {}).observation,
    text_container_observed: expanded, nodes_scanned: 4, clipped_subtrees_omitted: Number(clipped) };
  return { snapshot, entry: { schema_version: 1, region_observed: true, container_count: 1,
    controls_seen: Number(present), controls_scanned: Number(present), controls_truncated: false,
    potential_entries_seen: Number(present), entries: present && linked ? [{ position: 1, kind: 'aria_controls', tag: 'BUTTON',
      label: expanded ? '收起详情' : '展开详情', target_id: 'description-body', expanded, disabled: false }] : [] } };
}
