// Copy only the reviewed public stylesheet from the sibling design-system repo.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(process.argv[2] || `${root}../freewrite-ui-kit`);
const pkg = JSON.parse(await readFile(`${source}/package.json`, 'utf8'));
if (pkg.name !== '@kkumtree/backward-ui') throw new Error('Expected the Backward UI package.');
const css = await readFile(`${source}/assets/css/bw.css`);
if (!css.includes('--bw-surface:') || css.includes('--fw-')) throw new Error('Unexpected stylesheet namespace.');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
await mkdir(`${root}design-system`, { recursive: true });
await writeFile(`${root}design-system/bw.css`, css);
await writeFile(`${root}design-system/source.json`, JSON.stringify({ name: pkg.name, version: pkg.version, repository: pkg.repository.url, commit, sha256: createHash('sha256').update(css).digest('hex') }, null, 2) + '\n');
console.log(`Synced ${pkg.name}@${pkg.version} (${commit.slice(0, 7)}).`);
