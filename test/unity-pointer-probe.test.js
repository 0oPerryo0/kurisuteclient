const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unityPointerProbeScript } = require('../src/unity-pointer-probe');

test('setter pointer probe is valid and does not call Unity', () => {
  const source = unityPointerProbeScript();
  assert.doesNotThrow(() => new Function(source));
  assert.equal(source.includes('dynCall'), false);
  assert.equal(source.includes('SendMessage'), false);
  assert.match(source, /SetTimeScale/);
  assert.match(source, /time\.scale/);
  assert.equal(source.includes('96 * 1024 * 1024'), false);
});
