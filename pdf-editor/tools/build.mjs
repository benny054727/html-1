// Builds app.js from the files in src/ (in name order) inside one function scope.
// The site loads only app.js, so it keeps working without any build step on the server.
//   node tools/build.mjs          write app.js
//   node tools/build.mjs --check  fail if app.js is out of date (used by the tests)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'src')).filter(f => f.endsWith('.js')).sort();
const body = files.map(f => readFileSync(join(root, 'src', f), 'utf8')).join('');
const out = "(() => {\n'use strict';\n" + body + '})();\n';
const target = join(root, 'app.js');

if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== out) { console.error('app.js is out of date: run "node tools/build.mjs"'); process.exit(1); }
  console.log(`app.js is up to date (${files.length} source files)`);
} else {
  writeFileSync(target, out);
  console.log(`app.js written from ${files.length} source files`);
}
