const status = document.getElementById('status');

function update(state) {
  document.getElementById('pin').classList.toggle('active', state.pin);
  document.getElementById('gameOnly').classList.toggle('active', state.gameOnly);
  document.getElementById('fullscreen').classList.toggle('active', state.fullscreen);
  document.getElementById('mute').classList.toggle('active', state.mute);
  document.getElementById('zoom').value = String(state.zoom);
  document.getElementById('fps').value = String(state.fps);
  document.getElementById('speed').value = String(state.speed);
  const message = (state.status || '') + (state.speed > 1 ? ` · local clock ${state.speed}×` : '');
  status.textContent = message;
  status.title = message;
}

window.client.onState(update);
document.querySelectorAll('button[data-command]').forEach((button) => {
  button.addEventListener('click', async () => {
    try { update(await window.client.command(button.dataset.command)); }
    catch (error) { status.textContent = error.message; }
  });
});
for (const id of ['zoom', 'fps', 'speed']) {
  document.getElementById(id).addEventListener('change', async (event) => {
    try { update(await window.client.command(id, Number(event.target.value))); }
    catch (error) { status.textContent = error.message; }
  });
}
window.client.command('state').then(update).catch((error) => { status.textContent = error.message; });
