/**
 * Wall-clock text for a moment, in the machine's time zone with its offset. Callers once read an ISO time ending in Z as
 * local time and told the user 13:58 for a lock ending at 21:58 in UTC+08:00 (2026-11-08); messages now give both.
 * @param {number} ms Epoch milliseconds. @returns {string} For example "21:58 local time, 2026-11-08, UTC+08:00".
 */
export function localTimeText(ms) {
  const date = new Date(ms), pad = value => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-', minutes = Math.abs(offset);
  return `${pad(date.getHours())}:${pad(date.getMinutes())} local time, ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}, ` +
    `UTC${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** @param {number} ms @returns {string} The ISO time followed by the local wall-clock text. */
export const timeText = ms => `${new Date(ms).toISOString()} (${localTimeText(ms)})`;
