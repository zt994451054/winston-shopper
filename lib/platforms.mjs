import path from 'node:path';
import { ShoppingError } from './errors.mjs';
import { PACING_POLICY, PDD_PACING_POLICY } from './pacing.mjs';

/** Platforms the command interface can address. Saved records without a platform field predate JD and are Taobao. */
export const PLATFORMS = Object.freeze(['taobao', 'jd', 'pdd']);

/**
 * @param {unknown} value A --platform value, or undefined for the Taobao default.
 * @returns {'taobao'|'jd'|'pdd'}
 * @throws {ShoppingError} UNSUPPORTED_PLATFORM.
 * @example parsePlatform('jd') // 'jd'
 */
export function parsePlatform(value) {
  if (value === undefined) return 'taobao';
  if (!PLATFORMS.includes(value)) throw new ShoppingError('UNSUPPORTED_PLATFORM', 'Use --platform taobao, jd or pdd.');
  return value;
}

/**
 * Each platform keeps its own pacing ledger, so loads on one never use the other's quota. Taobao keeps the original file name.
 * @param {string} stateDirectory @param {'taobao'|'jd'|'pdd'} platform @returns {string}
 */
export function pacingFile(stateDirectory, platform) {
  return path.join(stateDirectory, platform === 'taobao' ? 'pacing.json' : `pacing-${parsePlatform(platform)}.json`);
}

/**
 * Pacing quotas for one platform. PDD starts lower than Taobao and JD (user decision, 2026-10-27).
 * @param {'taobao'|'jd'|'pdd'} platform @returns {object} A pacing policy for lib/pacing.mjs.
 */
export function pacingPolicy(platform) {
  return parsePlatform(platform) === 'pdd' ? PDD_PACING_POLICY : PACING_POLICY;
}
