import path from 'node:path';
import { ShoppingError } from './errors.mjs';

// Allowlist rather than denylist: anything not named here (history files, private state,
// installed dependencies, research records) stays out of the install package.
// The Playwright backend manifest and lock let `setup --install` reproduce the pinned versions; its node_modules stays out.
const PACKAGE_FILES = new Set(['SKILL.md', 'README.md', 'package.json', '.gitignore',
  'runtime/playwright-backend/package.json', 'runtime/playwright-backend/package-lock.json']);
const PACKAGE_DIRECTORIES = ['lib/', 'scripts/', 'references/', 'examples/', 'test/', 'test-support/'];

const PRIVATE_MARKERS = {
  absolute_home_path: /\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\/,
  phone_number: /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/,
};

const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g;

function invalidPath(file) {
  return new ShoppingError('INVALID_PACKAGE_PATH', `The tracked path ${JSON.stringify(file)} cannot be packaged.`,
    'Remove or rename the tracked file so it is a plain relative path inside the skill directory.');
}

/**
 * Select the tracked files that belong in the install package.
 * @param {string[]} trackedFiles Paths relative to the skill root, as printed by `git ls-files`.
 * @returns {string[]} Sorted package paths.
 * @throws {ShoppingError} INVALID_PACKAGE_PATH for absolute or parent-relative paths.
 */
export function selectPackageFiles(trackedFiles) {
  for (const file of trackedFiles) {
    if (path.posix.isAbsolute(file) || file.split('/').includes('..') || file.includes('\\')) throw invalidPath(file);
  }
  return trackedFiles.filter(file => PACKAGE_FILES.has(file) || PACKAGE_DIRECTORIES.some(directory => file.startsWith(directory))).sort();
}

function linkTarget(file, href) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return null;
  const [target] = href.split('#');
  let decoded;
  try { decoded = decodeURI(target); } catch { decoded = target; }
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded));
}

/**
 * Replace relative Markdown links whose target is not in the package with their plain text,
 * so an installed copy has no dead links to development records.
 * @param {string} markdown File contents.
 * @param {string} file Package path of the Markdown file.
 * @param {Set<string>} packaged Package paths that will exist after installation.
 * @returns {{text: string, removed: number}}
 * @example stripOutsideLinks('[记录](../../output/a.md)', 'references/x.md', new Set()) // {text:'记录', removed:1}
 */
export function stripOutsideLinks(markdown, file, packaged) {
  let removed = 0;
  const packagedDirectory = target => [...packaged].some(entry => entry.startsWith(`${target.replace(/\/$/, '')}/`));
  const text = markdown.replace(MARKDOWN_LINK, (whole, image, label, href) => {
    const target = linkTarget(file, href);
    if (target === null || packaged.has(target) || packagedDirectory(target)) return whole;
    removed += 1;
    return label;
  });
  return { text, removed };
}

/**
 * Name the private-data markers found in a packaged text file; values are never returned.
 * @param {string} text
 * @returns {string[]} Marker names, empty when nothing matched.
 */
export function findPrivateMarkers(text) {
  return Object.entries(PRIVATE_MARKERS).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
