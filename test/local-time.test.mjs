import test from 'node:test';
import assert from 'node:assert/strict';
import { localTimeText, utcOffsetText } from '../lib/local-time.mjs';

test('the UTC offset and the local time text name the same offset', () => {
  const moment = Date.UTC(2026, 10, 9, 3, 30);
  assert.match(utcOffsetText(moment), /^UTC[+-]\d\d:\d\d$/);
  assert.ok(localTimeText(moment).endsWith(utcOffsetText(moment)));
});
