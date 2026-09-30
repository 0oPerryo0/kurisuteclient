const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unityRuntimeInspectorScript } = require('../src/unity-runtime');

test('Unity runtime inspector is valid and does not call exports', () => {
  const source = unityRuntimeInspectorScript();
  assert.doesNotThrow(() => new Function(source));
  assert.equal(source.includes('SendMessage('), false);
  assert.equal(source.includes('.dynCall'), false);
  assert.match(source, /speedExports/);
  assert.match(source, /floatCallExports/);
});
