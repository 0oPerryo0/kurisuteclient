const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unityBuildAnalyzerScript } = require('../src/unity-build-analyzer');

test('Unity build analyzer generates valid script and matches build extensions', () => {
  const source = unityBuildAnalyzerScript();
  assert.doesNotThrow(() => new Function(source));
  const match = source.match(/const pattern = (\/.*\/i);/);
  assert.ok(match);
  const pattern = Function(`return ${match[1]}`)();
  assert.equal(pattern.test('https://example.com/Build/game.wasm.unityweb?x=1'), true);
  assert.equal(pattern.test('https://example.com/tracker'), false);
});
