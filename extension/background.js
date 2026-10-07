'use strict';

const TIM_HOSTS = new Set(['www.timhortons.ca', 'timhortons.ca']);
const HOME = 'https://www.timhortons.ca/';
let socket = null, pairToken = '', selectedTabId = null, heartbeat = null, retry = null, connectionGeneration = 0;
let status = 'Disconnected', commandQueue = Promise.resolve();
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,160}$/.test(value);
function allowedUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && TIM_HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443'); }
  catch { return false; }
}
function safeUrl(value) { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return HOME; } }
function fail(message, code = 'refused') { const error = new Error(message); error.code = code; throw error; }
async function timTab() {
  if (selectedTabId !== null) {
    try { const tab = await chrome.tabs.get(selectedTabId); if (allowedUrl(tab.url || tab.pendingUrl)) return tab; } catch {}
    selectedTabId = null;
  }
  const tabs = await chrome.tabs.query({ url: ['https://www.timhortons.ca/*', 'https://timhortons.ca/*'] });
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const tab = tabs.find(candidate => allowedUrl(candidate.url)) || await chrome.tabs.create({ url: HOME, active: true });
  selectedTabId = tab.id; return tab;
}
async function waitForTab(id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(id);
    if (!allowedUrl(tab.url || tab.pendingUrl)) fail('The Tim Hortons tab navigated outside the permitted website.');
    if (tab.status === 'complete') return tab;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  fail('The Tim Hortons page is still loading. Try a fresh snapshot.', 'timeout');
}
async function contentRpc(tab, method, params) {
  if (!allowedUrl((await chrome.tabs.get(tab.id)).url)) fail('Only the official Canadian Tim Hortons website is permitted.');
  const message = { type: 'sidekick.profile.rpc', method, params };
  let response;
  try { response = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 }); }
  catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'] });
    response = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  }
  if (!response?.ok) fail(response?.error?.message || 'The page refused this action.', response?.error?.code || 'refused');
  return response.result;
}
async function rpc(method, params = {}) {
  if (!['snapshot', 'navigate', 'action'].includes(method)) fail('Unsupported fixed command.');
  const tab = await timTab();
  // Keep the actual signed-in website visible while the person watches the task.
  await chrome.tabs.update(tab.id, { active: true });
  if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
  if (method === 'navigate') {
    if (!allowedUrl(params.url)) fail('Navigation is limited to timhortons.ca over HTTPS.');
    await chrome.tabs.update(tab.id, { url: params.url, active: true });
    const loaded = await waitForTab(tab.id); return { url: safeUrl(loaded.url), tab_id: tab.id };
  }
  await waitForTab(tab.id);
  if (method === 'action' && params.submit === true) {
    if (params.action !== 'click' || typeof params.approvedTotal !== 'number' || !Number.isFinite(params.approvedTotal) || params.approvedTotal <= 0 || params.approvedTotal > 100) fail('A final click requires a verified approved total.');
    const stored = await chrome.storage.local.get('purchaseLatchPair');
    if (stored.purchaseLatchPair === pairToken) fail('A final order attempt already occurred in this pairing. Check its actual result privately; it will not be repeated.', 'purchase_already_attempted');
    // Persist before the attempt. A lost reply or reload cannot cause a second purchase.
    await chrome.storage.local.set({ purchaseLatchPair: pairToken });
  }
  return contentRpc(tab, method, params);
}
function disconnect() {
  connectionGeneration++; clearInterval(heartbeat); clearTimeout(retry); heartbeat = retry = null;
  if (socket) { const old = socket; socket = null; old.close(); }
  status = 'Disconnected';
}
function connect() {
  disconnect();
  if (!validToken(pairToken)) return;
  const generation = connectionGeneration;
  status = 'Connecting to local Sidekick';
  const ws = new WebSocket('ws://127.0.0.1:4317/profile-browser', `sidekick.profile.${pairToken}`); socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    status = 'Connected to local Sidekick';
    ws.send(JSON.stringify({ type: 'profile_ready', protocol_version: 1, capabilities: { snapshot: true, action: true, navigate: true, screenshots: false } }));
    heartbeat = setInterval(() => { if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 20000);
  };
  ws.onmessage = event => {
    if (socket !== ws || typeof event.data !== 'string' || event.data.length > 65536) return;
    let request; try { request = JSON.parse(event.data); } catch { return; }
    if (request.type !== 'rpc' || !Number.isSafeInteger(request.id) || request.id < 1) return;
    commandQueue = commandQueue.catch(() => {}).then(async () => {
      if (socket !== ws || generation !== connectionGeneration) return;
      let reply;
      try { reply = { id: request.id, type: 'rpc_result', ok: true, result: await rpc(request.method, request.params) }; }
      catch (error) { reply = { id: request.id, type: 'rpc_result', ok: false, error: { code: error.code || 'failed', message: String(error.message || 'Command failed.').slice(0, 300) } }; }
      if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
    });
  };
  ws.onerror = () => { if (socket === ws) status = 'Local bridge unavailable or pairing refused'; };
  ws.onclose = () => {
    if (socket !== ws) return;
    clearInterval(heartbeat); heartbeat = null; socket = null; status = 'Local bridge offline';
    if (validToken(pairToken)) retry = setTimeout(connect, 5000);
  };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  (async () => {
    if (message.type === 'status') return { status, connected: socket?.readyState === WebSocket.OPEN, paired: validToken(pairToken) };
    if (message.type === 'pair') {
      if (!validToken(message.pairToken)) fail('Enter the pairing code provided by your local Sidekick setup.');
      pairToken = message.pairToken; await chrome.storage.local.set({ pairToken, disabled: false }); connect(); return { status };
    }
    if (message.type === 'disconnect') {
      pairToken = ''; await chrome.storage.local.set({ disabled: true }); await chrome.storage.local.remove('pairToken'); disconnect(); return { status };
    }
    fail('Unsupported setup request.');
  })().then(result => respond({ ok: true, ...result })).catch(error => respond({ ok: false, error: String(error.message).slice(0, 300) }));
  return true;
});
async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const stored = await chrome.storage.local.get(['pairToken', 'disabled']);
  if (stored.disabled) return;
  pairToken = validToken(stored.pairToken) ? stored.pairToken : '';
  if (!pairToken) {
    try { const response = await fetch(chrome.runtime.getURL('pairing.json')); if (response.ok) { const bundled = await response.json(); if (validToken(bundled.pairToken)) pairToken = bundled.pairToken; } } catch {}
    if (pairToken) await chrome.storage.local.set({ pairToken });
  }
  connect();
}
initialize().catch(() => { status = 'Open the extension to pair Sidekick'; });
