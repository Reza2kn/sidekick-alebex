import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const HOSTS = new Set(['timhortons.ca', 'www.timhortons.ca']);
const LOCAL_HOSTS = new Set(['127.0.0.1:4317', 'localhost:4317', '[::1]:4317']);
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cdn-loop'];
const FINAL = /^(?:place|submit|confirm|complete)\s+(?:(?:my|delivery|pickup|secure)\s+)?order(?:\s+(?:for\s+)?(?:CA\$|C\$|\$)\s*\d+(?:\.\d{2})?)?$/i;
const PURCHASE = /\b(?:pay(?:ment)?|place\s+(?:(?:my|delivery|pickup|secure)\s+)?order|submit\s+(?:order|purchase)|complete\s+(?:order|purchase)|confirm\s+(?:order|purchase)|buy\s+now|purchase)\b/i;
const PRIVATE = /password|e-?mail|phone|\btel\b|credit|card.?number|cvv|cvc|payment|billing|security.?code|one.?time|otp|verification.?code|sign\s*in|log\s*in|register|create\s+account/i;
const clean = (value, max = 240) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '';
const validRevision = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value);
function allowedUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443'); }
  catch { return false; }
}
function failure(message, code = 'refused') { const error = new Error(message); error.code = code; return error; }
function safeError(value) {
  const code = ['refused', 'failed', 'timeout', 'stale_revision', 'unavailable', 'busy'].includes(value?.code) ? value.code : 'failed';
  const messages = { refused: 'The connected browser refused this action. Take a fresh snapshot or use private human setup.', failed: 'The connected browser could not complete this action.', timeout: 'The connected browser did not finish in time. Check the visible page before proceeding.', stale_revision: 'The page changed. Take a fresh snapshot before acting.', unavailable: 'The local browser profile is disconnected.', busy: 'The local browser profile is busy.' };
  return { code, message: messages[code] };
}
function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || !allowedUrl(raw.url) || !validRevision(raw.revision)) throw failure('The browser returned an invalid page snapshot.');
  const captured = Date.parse(raw.captured_at);
  if (!Number.isFinite(captured) || Date.now() - captured > 60000 || captured - Date.now() > 30000) throw failure('The browser snapshot is stale.', 'stale_revision');
  if (!Array.isArray(raw.controls) || raw.controls.length > 140) throw failure('The browser snapshot has invalid page controls.');
  const ids = new Set();
  const controls = raw.controls.map(control => {
    if (!control || !Number.isSafeInteger(control.id) || control.id < 1 || ids.has(control.id)) throw failure('The browser snapshot has invalid page targets.');
    ids.add(control.id);
    return Object.freeze({ id: control.id, role: clean(control.role, 40), tag: clean(control.tag, 40), label: clean(control.label), context: clean(control.context, 360),
      input_type: clean(control.input_type, 40) || null, input_name: clean(control.input_name, 100) || null,
      href: typeof control.href === 'string' ? clean(control.href, 1000) : null,
      disabled: control.disabled === true, checked: control.checked === true, sensitive: control.sensitive === true,
      ...(control.branch_card_context ? { branch_card_context: clean(control.branch_card_context, 800) } : {}),
      ...(Array.isArray(control.options) ? { options: control.options.slice(0, 12).map(option => ({ label: clean(option?.label), selected: option?.selected === true })) } : {}) });
  });
  return Object.freeze({ bridge_version: clean(raw.bridge_version, 80), url: raw.url, captured_at: new Date(captured).toISOString(), revision: raw.revision, title: clean(raw.title, 120),
    visibleText: clean(raw.visibleText, 12000), controls: Object.freeze(controls), pickupAreas: Object.freeze((Array.isArray(raw.pickupAreas) ? raw.pickupAreas : []).slice(0, 60).map(value => clean(value, 360)).filter(Boolean)) });
}

/** Local-only fixed browser commands; the HTTP server owns upgrade routing. */
export function createProfileBridge({ pairToken, getPairToken, server } = {}) {
  const token = () => typeof getPairToken === 'function' ? getPairToken() : pairToken;
  if (typeof token() !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(token())) throw failure('A private browser pairing token is required.');
  let connection = null, ready = false, readyTimer = null, lastView = null, nextId = 0, purchaseAttempted = false;
  const pending = new Map();
  const protocol = () => `sidekick.profile.${token()}`;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 120000, handleProtocols: protocols => protocols.has(protocol()) ? protocol() : false });
  const isConnected = () => ready && connection?.readyState === WebSocket.OPEN;
  function rejectPending() {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure('The local browser profile disconnected.', 'unavailable')); }
    pending.clear(); lastView = null;
  }
  function rpc(method, params) {
    if (!isConnected()) return Promise.reject(failure('The local browser profile is disconnected.', 'unavailable'));
    if (pending.size >= 5) return Promise.reject(failure('The local browser profile is busy.', 'busy'));
    if (nextId >= Number.MAX_SAFE_INTEGER) return Promise.reject(failure('The local browser profile needs reconnecting.', 'unavailable'));
    const id = ++nextId, request = JSON.stringify({ id, type: 'rpc', method, params });
    if (Buffer.byteLength(request) > 120000) return Promise.reject(failure('The browser command is too large.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(failure('The browser command timed out. Inspect the visible page before proceeding.', 'timeout')); }, method === 'navigate' ? 20000 : 15000);
      timer.unref?.(); pending.set(id, { resolve, reject, timer });
      connection.send(request, error => { if (!error || !pending.has(id)) return; clearTimeout(timer); pending.delete(id); reject(failure('The browser command could not be sent.', 'unavailable')); });
    });
  }
  const fixedDriver = Object.freeze({
    async navigate(url) {
      if (!allowedUrl(url) || String(url).length > 2000) throw failure('Navigation is limited to the official Canadian Tim Hortons website.');
      lastView = null; const result = await rpc('navigate', { url });
      if (!result || !allowedUrl(result.url)) throw failure('The connected browser did not verify the permitted destination.');
      return { url: result.url };
    },
    async snapshot(step = 0) {
      if (!Number.isSafeInteger(step) || step < 0 || step > 10000) throw failure('A bounded snapshot step is required.');
      lastView = null; const result = sanitizeSnapshot(await rpc('snapshot', { step })); lastView = result; return result;
    },
    async action(action, view) {
      if (!action || !['click', 'fill', 'scroll', 'wait'].includes(action.action)) throw failure('Only fixed browser actions are permitted.');
      // Worker settling waits do not reuse a DOM revision or execute browser code.
      if (action.action === 'wait') {
        if (!isConnected()) throw failure('The local browser profile is disconnected.', 'unavailable');
        const milliseconds = Number.isFinite(action.milliseconds) ? Math.max(0, Math.min(1000, action.milliseconds)) : 250;
        await new Promise(resolve => setTimeout(resolve, milliseconds));
        return { ok: true, performed: 'wait', purchase_attempted: false };
      }
      if (!lastView || view?.revision !== lastView.revision || Date.now() - Date.parse(lastView.captured_at) > 30000) throw failure('Take a fresh snapshot before acting.', 'stale_revision');
      const params = { revision: lastView.revision, action: action.action };
      let control;
      if (action.action === 'click' || action.action === 'fill') {
        if (!Number.isSafeInteger(action.target_id)) throw failure('Use a numbered target from the current snapshot.');
        control = lastView.controls.find(value => value.id === action.target_id);
        if (!control || control.disabled || control.sensitive || (control.href && !allowedUrl(control.href))) throw failure('That browser target is unavailable or private.');
        params.target_id = control.id;
        if (/\b(?:sign\s*in|log\s*in|register|create\s+account)\b/i.test(control.label)) throw failure('Account setup requires private human control.');
      }
      if (action.action === 'fill') {
        if (!['input', 'textarea', 'select'].includes(control.tag.toLowerCase()) || /^(file|hidden|submit|button|radio|checkbox|password|email|tel)$/i.test(control.input_type || '') || PRIVATE.test(`${control.label} ${control.input_name}`) || typeof action.value !== 'string' || action.value.length > 500) throw failure('This field requires private human control or the value is invalid.');
        params.value = action.value;
      }
      if (action.action === 'scroll') {
        if (!['up', 'down'].includes(action.direction)) throw failure('A scroll direction is required.');
        params.direction = action.direction;
      }
      if (action.approvedPurchase !== undefined) {
        const approval = action.approvedPurchase;
        if (action.action !== 'click' || !FINAL.test(control.label.trim()) || !approval || !Number.isFinite(approval.total_cad) || approval.total_cad <= 0 || approval.total_cad > 500 || approval.payment_method !== 'Tim Card' || approval.single_attempt !== true || purchaseAttempted) throw failure('The approved purchase command is invalid or has already been attempted.');
        params.submit = true; params.approvedTotal = approval.total_cad;
        // Set before sending. A timeout or disconnect must never trigger a retry.
        purchaseAttempted = true;
      } else if (action.action === 'click' && PURCHASE.test(control.label)) throw failure('A purchase requires the trusted exact-total approval command.');
      lastView = null;
      try {
        const result = await rpc('action', params);
        if (!result || !['click', 'fill', 'scroll', 'wait'].includes(result.performed)) throw failure('The browser did not confirm that the action was performed.');
        return { ok: true, performed: result.performed, ...(Number.isSafeInteger(result.target_id) ? { target_id: result.target_id } : {}), purchase_attempted: result.purchase_attempted === true };
      } catch (error) { if (['unavailable', 'timeout'].includes(error?.code)) throw error; return { ok: false, error: safeError(error) }; }
    },
    release() { lastView = null; }
  });
  function refuseUpgrade(socket, status = 403) { if (!socket.destroyed) { socket.write(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); } }
  function handleUpgrade(req, socket, head) {
    const address = req.socket?.remoteAddress;
    const origin = req.headers?.origin;
    if (req.method !== 'GET' || req.url !== '/profile-browser' || !['127.0.0.1', '::1'].includes(address) || !LOCAL_HOSTS.has(req.headers?.host) || PROXY_HEADERS.some(name => req.headers?.[name] !== undefined) || (origin !== undefined && (typeof origin !== 'string' || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)))) return refuseUpgrade(socket);
    const offered = String(req.headers?.['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
    const expected = Buffer.from(protocol());
    const authenticated = offered.some(value => { const candidate = Buffer.from(value); return candidate.length === expected.length && timingSafeEqual(candidate, expected); });
    if (!authenticated) return refuseUpgrade(socket);
    if (connection && connection.readyState !== WebSocket.CLOSED) return refuseUpgrade(socket, 409);
    try { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); }
    catch { refuseUpgrade(socket); }
  }
  wss.on('connection', ws => {
    connection = ws; ready = false; lastView = null;
    readyTimer = setTimeout(() => { if (connection === ws && !ready) ws.close(1008, 'Profile readiness required'); }, 5000); readyTimer.unref?.();
    ws.on('message', (data, isBinary) => {
      if (connection !== ws) return;
      if (isBinary || data.length > 120000) return ws.close(1008, 'JSON messages required');
      let message; try { message = JSON.parse(data.toString()); } catch { return ws.close(1008, 'Invalid JSON'); }
      if (!message || typeof message !== 'object') return ws.close(1008, 'Invalid message');
      if (message.type === 'profile_ready') { ready = true; clearTimeout(readyTimer); return; }
      if (message.type === 'ping' && ready) return;
      if (!ready || message.type !== 'rpc_result' || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.ok !== 'boolean') return ws.close(1008, 'Invalid command result');
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.ok) item.resolve(message.result); else { const safe = safeError(message.error); item.reject(failure(safe.message, safe.code)); }
    });
    ws.on('close', () => { if (connection !== ws) return; clearTimeout(readyTimer); connection = null; ready = false; rejectPending(); });
    ws.on('error', () => {});
  });
  function close() { clearTimeout(readyTimer); connection?.close(1001, 'Local bridge closing'); ready = false; rejectPending(); wss.close(); }
  server?.once('close', close);
  return Object.freeze({ isConnected, readerVersion() { return lastView?.bridge_version || null; }, driver() { if (!isConnected()) throw failure('The local browser profile is disconnected.', 'unavailable'); return fixedDriver; }, handleUpgrade, close });
}
