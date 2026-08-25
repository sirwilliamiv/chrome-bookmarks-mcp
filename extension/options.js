const tokenField = document.getElementById('token');
const portField = document.getElementById('port');
const saveButton = document.getElementById('save');
const dot = document.getElementById('dot');
const detail = document.getElementById('detail');

function render(status) {
  const connected = Boolean(status && status.connected);
  dot.textContent = connected ? 'connected' : 'offline';
  dot.className = `dot ${connected ? 'ok' : 'bad'}`;
  detail.textContent = (status && status.detail) || 'Waiting for the service worker.';
}

async function load() {
  const stored = await chrome.storage.local.get(['token', 'port', 'status']);
  tokenField.value = stored.token || '';
  portField.value = stored.port || 45732;
  render(stored.status);
}

saveButton.addEventListener('click', async () => {
  await chrome.storage.local.set({
    token: tokenField.value.trim(),
    port: Number(portField.value) || 45732
  });
  detail.textContent = 'Saved. Reconnecting.';
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.status) render(changes.status.newValue);
});

load();
