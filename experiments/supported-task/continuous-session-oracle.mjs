import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.argv[2];
if (!source) throw new Error('Pass the source string.service.ts path');

const module = await import(pathToFileURL(resolve(source)).href);
const StringUtils = module.StringUtils ?? module.default?.StringUtils;
assert.equal(typeof StringUtils?.reverse, 'function');

for (const [input, expected] of [
  ['A😀B', 'B😀A'],
  ['hello', 'olleh'],
  ['', ''],
]) {
  assert.equal(StringUtils.reverse({ input }), expected, `reverse(${JSON.stringify(input)})`);
}

console.log('Evaluator oracle passed');
