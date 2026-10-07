'use strict';
const status = document.getElementById('status');
async function updateStatus() {
  try { const result = await chrome.runtime.sendMessage({ type: 'status' }); status.textContent = result.status || 'Disconnected'; document.getElementById('pair-form').hidden = Boolean(result.connected); }
  catch { status.textContent = 'The extension is starting. Please try again.'; }
}
document.getElementById('pair-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = document.getElementById('connect'); button.disabled = true;
  try { const result = await chrome.runtime.sendMessage({ type: 'pair', pairToken: document.getElementById('pair-code').value.trim() }); status.textContent = result.error || result.status || 'Connecting'; if (result.ok) document.getElementById('pair-code').value = ''; }
  catch { status.textContent = 'Could not connect. Check that the local Sidekick server is running.'; }
  finally { button.disabled = false; }
});
document.getElementById('disconnect').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'disconnect' }); updateStatus(); });
updateStatus(); setInterval(updateStatus, 1500);
