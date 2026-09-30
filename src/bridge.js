const enabled = document.getElementById('enabled');
const object = document.getElementById('object');
const method = document.getElementById('method');
const result = document.getElementById('result');

window.client.command('state').then((state) => {
  enabled.checked = state.bridgeEnabled;
  object.value = state.bridgeObject;
  method.value = state.bridgeMethod;
}).catch((error) => { result.textContent = error.message; });

document.getElementById('save').addEventListener('click', async () => {
  try {
    const state = await window.client.command('bridgeSettings', {
      enabled: enabled.checked, object: object.value.trim(), method: method.value.trim(),
    });
    result.textContent = state.status;
  } catch (error) { result.textContent = error.message; }
});

document.getElementById('guesses').addEventListener('click', async () => {
  result.textContent = 'Trying common Unity targets…';
  try {
    const state = await window.client.command('tryUnityGuesses');
    result.textContent = state.status;
  } catch (error) { result.textContent = error.message; }
});

document.getElementById('runtime').addEventListener('click', async () => {
  result.textContent = 'Inspecting the loaded Unity instance…';
  try {
    const state = await window.client.command('inspectUnityRuntime');
    result.textContent = state.status;
  } catch (error) { result.textContent = error.message; }
});

document.getElementById('pointers').addEventListener('click', async () => {
  result.textContent = 'Searching the Unity heap for the setter. This does not call it…';
  try {
    const state = await window.client.command('probeUnityPointers');
    result.textContent = state.status;
  } catch (error) { result.textContent = error.message; }
});

document.getElementById('analyze').addEventListener('click', async () => {
  result.textContent = 'Scanning Unity build assets locally; this may take a moment…';
  try {
    const state = await window.client.command('analyzeUnityBuild');
    result.textContent = state.status;
  } catch (error) { result.textContent = error.message; }
});
