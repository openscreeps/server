#!/usr/bin/env node
/*
 * Composes this server's HTTP contract from the pinned official Screeps contract, its standalone
 * compatibility profile and the server-owned extensions (`api/extensions.json`), then generates
 * the TypeScript client, operation manifest and handler types from the composed document.
 *
 *   node scripts/generate-api.mjs           write api/openapi.{json,yaml} and src/generated/api
 *   node scripts/generate-api.mjs --check   fail (exit 1) when any output is missing or stale
 *
 * Output is deterministic: it depends only on the pinned @openscreeps/openapi package and
 * api/extensions.json. `--check` never writes.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { composeProfile } from '@openscreeps/openapi/contracts';
import { generateClientFiles } from '@openscreeps/openapi/generate';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const unknown = process.argv.slice(2).filter((argument) => argument !== '--check');
if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(' ')}`);

const GENERATED_DIRECTORY = 'src/generated/api';
const CLIENT_NAME = 'openscreeps';
const CLIENT_RUNTIME = '@openscreeps/openapi/client-runtime';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const official = await readJson(
  fileURLToPath(import.meta.resolve('@openscreeps/openapi/official')),
);
const profile = await readJson(
  fileURLToPath(import.meta.resolve('@openscreeps/openapi/profiles/standalone')),
);
const extensions = await readJson(resolve(root, 'api/extensions.json'));
const { version } = await readJson(resolve(root, 'package.json'));
const composed = composeProfile(official, profile, extensions);
/** Server-owned identity; the official contract version the profile targets stays recorded. */
const document = {
  ...composed,
  info: {
    ...composed.info,
    title: 'OpenScreeps server HTTP API',
    version,
    'x-official-version': official.info.version,
  },
};
/** Expected file contents by repository-relative path. */
const outputs = new Map([
  ['api/openapi.json', JSON.stringify(document, null, 2) + '\n'],
  ['api/openapi.yaml', stringify(document, { lineWidth: 100, aliasDuplicateObjects: false })],
]);
const generated = await generateClientFiles({
  document,
  name: CLIENT_NAME,
  runtime: CLIENT_RUNTIME,
});
for (const [name, content] of Object.entries(generated).sort(([a], [b]) => a.localeCompare(b))) {
  outputs.set(`${GENERATED_DIRECTORY}/${name}`, content);
}

async function readText(path) {
  try {
    return (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Files below the generated directory that the generator no longer produces. */
async function strayFiles() {
  const directory = resolve(root, GENERATED_DIRECTORY);
  let entries;
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .filter((path) => !outputs.has(path))
    .sort();
}

const stale = [];
for (const [path, content] of outputs) {
  if ((await readText(resolve(root, path))) !== content) stale.push(path);
}
const stray = await strayFiles();

if (check) {
  if (stale.length || stray.length) {
    console.error('Generated API artifacts are stale. Run `npm run generate:api` and commit:');
    for (const path of stale) console.error(`  stale: ${path}`);
    for (const path of stray) console.error(`  unexpected: ${path}`);
    process.exit(1);
  }
} else {
  for (const path of stale) {
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, outputs.get(path));
  }
  for (const path of stray) await rm(resolve(root, path));
}

const operations = Object.values(document.paths).reduce(
  (count, item) =>
    count +
    Object.keys(item).filter((key) =>
      ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(key),
    ).length,
  0,
);
console.log(
  `${check ? 'Verified' : stale.length || stray.length ? 'Generated' : 'Unchanged'} ` +
    `${String(outputs.size)} API artifacts for ${String(operations)} operations.`,
);
