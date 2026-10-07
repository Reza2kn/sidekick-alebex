'use strict';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get('token');
const state = { session: null, socket: null, context: null, micStream: null, micNode: null, micSource: null, micSink: null, muted: false, running: false, starting: false, startGeneration: 0, userInitiated: false, agentActive: false, lastAnnouncement: '', lastAnnouncementAt: 0, listenOnly: false, silenceTimer: null, statusTimer: null, locationSource: null, lastDeviceLocationAt: 0, locationRefreshPending: false, locationRetryAfter: 0, connected: false, greetingAcknowledged: false, nextAudioAt: 0, sources: new Set(), marks: [], markTimer: null, cameraStream: null, cameraPending: null, cameraGeneration: 0, uploaded: null, uploadedSource: 'upload', conversationCount: 0, lastMessage: null, activityCount: 0, capturePending: false };

function announceNotice(message, error) {
  if (!message || !state.userInitiated) return;
  if (state.lastAnnouncement === message && Date.now() - state.lastAnnouncementAt < 3000) return;
  state.lastAnnouncement = message; state.lastAnnouncementAt = Date.now();
  if (state.running && (state.connected || state.agentActive)) { send({ type: 'app_client_notice', message, error: Boolean(error) }); return; }
  if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
    window.speechSynthesis.cancel();
    const speech = new window.SpeechSynthesisUtterance(message); speech.lang = 'en-CA'; speech.rate = 1;
    window.speechSynthesis.speak(speech);
  }
}
function notice(message, error = false, { announce = true } = {}) {
  $('notice').textContent = message || '';
  $('notice').hidden = !message;
  $('notice').setAttribute('role', error ? 'alert' : 'status');
  if (announce) announceNotice(message, error);
}
function voiceStatus(kind, label, detail) {
  $('voice-stage').dataset.state = kind;
  $('voice-label').textContent = label;
  $('voice-detail').textContent = detail || '';
}
function refreshVoiceStatus() {
  if (!state.running) return;
  if (state.sources.size) voiceStatus('speaking', 'Sidekick is speaking', state.listenOnly ? 'Send a typed follow-up or share an image.' : 'You can interrupt or ask a follow-up.');
  else if (!state.greetingAcknowledged) voiceStatus('connecting', 'Meeting your Sidekick', 'The conversation starts after the greeting.');
  else if (state.listenOnly) voiceStatus('ready', 'Listen-only demo', 'Type a request below, or choose something to ask.');
  else if (state.muted) voiceStatus('muted', 'Microphone muted.', 'Press Unmute whenever you’re ready.');
  else voiceStatus('listening', 'I’m listening', 'Ask me something. We can take it one step at a time.');
}
async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body) });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) throw new Error(result.message || result.error || `Request failed (${response.status}).`);
  return result;
}
function updateCapabilities(capabilities) {
  if (!capabilities) return;
  const webOrder = Boolean(capabilities.webOrder);
  $('phone-chip').textContent = webOrder ? 'Website ordering connected' : 'Website ordering unavailable';
  $('phone-chip').classList.toggle('available', webOrder);
  $('phone-chip').setAttribute('aria-label', webOrder ? 'Website ordering is connected' : 'Website ordering is unavailable');
  $('model-label').textContent = `Voice by Alebex · Vision ${capabilities.vision ? 'connected' : 'unavailable'}`;
}
async function refreshCapabilities() {
  try {
    const response = await fetch('/api/status', { credentials: 'same-origin' });
    if (!response.ok) return;
    const status = await response.json();
    updateCapabilities(status.capabilities);
  } catch { /* Keep the last verified state if a transient status read fails. */ }
}
function refreshDeviceLocation() {
  if (!state.running || state.listenOnly || state.locationSource !== 'device' || state.locationRefreshPending || Date.now() < state.locationRetryAfter || Date.now() - state.lastDeviceLocationAt < 60000) return;
  state.locationRefreshPending = true;
  const generation = state.startGeneration;
  shareLocation(false, { automatic: true, generation, refresh: true }).finally(() => {
    if (generation === state.startGeneration) state.locationRefreshPending = false;
  });
}
async function bootstrap() {
  try {
    state.session = await api('/api/session', {});
    if (token) history.replaceState(null, '', location.pathname + location.search);
    $('connection-status').textContent = 'Ready with Alebex';
    $('connection-dot').classList.add('ready');
    updateCapabilities(state.session.capabilities);
    $('test-tools').hidden = !new URLSearchParams(location.search).has('test');
    return state.session;
  } catch (error) {
    $('connection-status').textContent = 'Connection needed';
    notice(error.message, true);
    return null;
  }
}
const initialSession = bootstrap();

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) { state.socket.send(JSON.stringify(payload)); return true; }
  return false;
}
function conversation(role, value) {
  let content = typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => v.text || '').join('\n') : value?.text || '';
  content = content.trim();
  if (!content) return;
  const normalizedRole = String(role || '').trim().toLowerCase();
  const speaker = ['assistant', 'agent'].includes(normalizedRole) ? 'assistant' : ['user', 'caller'].includes(normalizedRole) ? 'user' : null;
  if (!speaker) {
    activity({ title: ['system', 'developer'].includes(normalizedRole) ? 'System conversation event' : ['tool', 'function'].includes(normalizedRole) ? 'Tool conversation event' : 'Conversation event with no verified speaker', message: content, source: 'Alebex conversation event', status: `Event role: ${normalizedRole || 'unspecified'}` });
    return;
  }
  if (state.lastMessage === `${speaker}:${content}`) return;
  state.lastMessage = `${speaker}:${content}`;
  $('conversation-empty')?.remove();
  const entry = document.createElement('div');
  entry.className = `message ${speaker}`;
  const label = document.createElement('p'); label.className = 'message-label'; label.textContent = speaker === 'assistant' ? 'Sidekick' : 'You';
  const text = document.createElement('p'); text.className = 'message-text'; text.textContent = content;
  entry.append(label, text); $('conversation').append(entry);
  state.conversationCount++;
  $('conversation-count').textContent = `${state.conversationCount} messages`;
  $('conversation').scrollTop = $('conversation').scrollHeight;
}
function websiteTaskPresentation(event) {
  const rawStatus = String(event.status || event.state || event.result?.status || '');
  const submitted = event.order_submitted === true || (event.order_submitted === undefined && event.result?.order_submitted === true);
  const unverifiedCompletion = /^(ordered|submitted|order_confirmed|completed|complete|success|succeeded)$/.test(rawStatus) && !submitted;
  const labels = { queued: 'Task queued', awaiting_operator: 'Checking the website', browsing: 'Checking the website', preparing: 'Preparing your cart', cart_prepared: 'Cart prepared', cart_ready: 'Ready for your approval', ready_for_review: 'Ready for your approval', verifying_approval: 'Checking your approved cart', submitting: 'Submitting your approved order', checking_confirmation: 'Checking for an order confirmation', ordered: 'Order confirmed', unknown: 'Order outcome unconfirmed', needs_takeover: 'Secure website needs your attention', needs_review: 'Fresh cart review needed', needs_input: 'More details needed', needs_details: 'More details needed', waiting_user: 'Waiting for your answer', unavailable: 'Website task unavailable', failed: 'Website task could not finish', cancelled: 'Task cancelled' };
  return { status: unverifiedCompletion ? 'Order outcome unconfirmed' : labels[rawStatus] || rawStatus.replace(/_/g, ' '), unverifiedCompletion };
}
function activity(event) {
  $('activity-empty')?.remove();
  const entry = document.createElement('article'); entry.className = 'activity';
  const header = document.createElement('div'); header.className = 'activity-header';
  const friendlyTools = { get_location: 'Checking your location', find_nearby_places: 'Looking up nearby places', find_nearby_amenities: 'Checking Vancouver amenities', find_local_amenities: 'Checking Vancouver amenities', look_at_camera: 'Looking at your image', prepare_tim_hortons_order: 'Preparing your Tim Hortons order', approve_tim_hortons_order: 'Your approved website order', get_task_status: 'Checking your task', prepare_assistance_call: 'Preparing a call for your approval', start_assistance_call: 'Starting your approved call', get_assistance_call_status: 'Checking the call outcome', phone_result: 'Call outcome', location: 'Location shared' };
  const previewUrl = event.preview_url || event.result?.preview_url;
  const verifiedPreview = typeof previewUrl === 'string' && /^\/api\/browser\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/screenshot$/i.test(previewUrl);
  const websiteTask = verifiedPreview || /tim_hortons|web.?order|browser/i.test(`${event.tool || ''} ${event.kind || event.result?.kind || ''} ${event.type === 'job_update' ? event.title || event.target || '' : ''}`);
  const websitePresentation = websiteTask ? websiteTaskPresentation(event) : null;
  const title = document.createElement('p'); title.className = 'activity-title'; title.textContent = websitePresentation?.unverifiedCompletion ? 'Website outcome unconfirmed' : event.title || event.label || friendlyTools[event.tool] || event.tool || event.toolName || event.name || (event.type === 'job_update' ? 'Task update' : 'Checked a source');
  const time = document.createElement('time'); time.className = 'activity-time'; time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  header.append(title, time); entry.append(header);
  const bodyValue = websitePresentation?.unverifiedCompletion ? 'The website has not returned a verified order confirmation. Check the secure order review before trying again.' : event.message || event.summary || event.spoken || event.result || event.detail || event.spokenResult || event.spoken_result;
  if (bodyValue) { const body = document.createElement('p'); body.className = 'activity-body'; body.textContent = typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue, null, 2); entry.append(body); }
  const nestedSources = event.result?.sources;
  const sources = Array.isArray(event.sources) ? event.sources : Array.isArray(nestedSources) ? nestedSources : event.source ? [event.source] : event.result?.source ? [event.result.source] : event.url ? [event.url] : [];
  for (const source of sources.slice(0, 4)) {
    const url = typeof source === 'string' ? source : source.url;
    if (url && /^https?:\/\//i.test(url)) { try { const parsed = new URL(url); const link = document.createElement('a'); link.className = 'activity-source'; link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = typeof source === 'object' ? source.title || source.name || source.provider || parsed.hostname : parsed.hostname; entry.append(link); } catch {} }
    else if (source) { const label = document.createElement('span'); label.className = 'activity-source'; label.textContent = typeof source === 'string' ? source : source.title || source.name || source.provider || (source.image_source === 'upload' ? 'Your selected photo' : source.image_source ? 'Your camera image' : 'Source checked'); entry.append(label); }
  }
  if (websitePresentation?.status || event.status || event.state) { const status = document.createElement('div'); status.className = 'activity-state'; status.textContent = websitePresentation?.status || event.status || event.state; entry.append(status); }
  if (verifiedPreview) {
    const figure = document.createElement('figure'); figure.className = 'website-preview';
    const image = document.createElement('img'); image.src = previewUrl; image.loading = 'lazy'; image.alt = 'Current Tim Hortons website view';
    const caption = document.createElement('figcaption'); caption.textContent = 'Current Tim Hortons website view';
    figure.append(image, caption); entry.append(figure);
  }
  if (websiteTask) {
    const websiteStatus = $('website-task-status'); websiteStatus.hidden = false;
    const taskState = websitePresentation.status;
    websiteStatus.textContent = `${websitePresentation.unverifiedCompletion ? 'Website outcome unconfirmed' : event.title || event.target || 'Tim Hortons website task'}${taskState ? ` · ${taskState}` : ''}${typeof bodyValue === 'string' ? `: ${bodyValue}` : ''}`;
  }
  $('activity-list').prepend(entry);
  while ($('activity-list').children.length > 25) $('activity-list').lastChild.remove();
  state.activityCount++;
}

function decodePCM(base64, rate) {
  const bytes = atob(base64);
  const audio = state.context.createBuffer(1, Math.floor(bytes.length / 2), Number(rate) || 24000);
  const channel = audio.getChannelData(0);
  for (let i = 0; i < channel.length; i++) { let sample = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8); if (sample & 0x8000) sample -= 65536; channel[i] = sample / 32768; }
  return audio;
}
function playAudio(event) {
  if (!state.context || !state.running || !event.data) return;
  state.agentActive = true;
  window.speechSynthesis?.cancel();
  const buffer = decodePCM(event.data, event.sample_rate);
  const source = state.context.createBufferSource(); source.buffer = buffer; source.connect(state.context.destination);
  const at = Math.max(state.nextAudioAt, state.context.currentTime + 0.18);
  state.nextAudioAt = at + buffer.duration;
  source.sidekickEndAt = state.nextAudioAt;
  state.sources.add(source);
  source.onended = () => { state.sources.delete(source); refreshVoiceStatus(); flushMarks(); };
  source.start(at); refreshVoiceStatus();
}
function flushMarks(force = false) {
  clearTimeout(state.markTimer); state.markTimer = null;
  if (!state.context) return;
  const now = state.context.currentTime;
  while (state.marks.length) {
    const mark = state.marks[0];
    const precedingPlaying = [...state.sources].some(source => source.sidekickEndAt <= mark.finishAt + 0.0001);
    if (!force && (now < mark.finishAt || precedingPlaying)) break;
    state.marks.shift();
    if (send(force ? { ...mark.payload, playback_cancelled: true } : mark.payload)) state.greetingAcknowledged = true;
  }
  refreshVoiceStatus();
  if (state.marks.length && !force) state.markTimer = setTimeout(() => flushMarks(), Math.max(25, (state.marks[0].finishAt - state.context.currentTime) * 1000 + 25));
}
function clearAudio() {
  for (const source of state.sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
  state.sources.clear();
  state.nextAudioAt = state.context?.currentTime || 0;
  flushMarks(true);
}

async function handleEvent(event) {
  switch (event.type) {
    case 'audio': playAudio(event); break;
    case 'mark': state.marks.push({ payload: event, finishAt: state.nextAudioAt || state.context?.currentTime || 0 }); flushMarks(); break;
    case 'clear_audio': clearAudio(); break;
    case 'call_started': state.connected = true; state.agentActive = true; window.speechSynthesis?.cancel(); $('connection-status').textContent = 'Live with Alebex'; refreshVoiceStatus(); break;
    case 'conversation_message': conversation(event.role || event.message?.role, event.content || event.text || event.message?.content || event.message?.text); break;
    case 'transcript':
    case 'transcription': if (event.is_final === true || event.final === true || event.status === 'final') conversation(event.role || 'user', event.content || event.text || event.transcript); break;
    case 'snapshot_request': await answerSnapshot(event); break;
    case 'tool_activity':
    case 'job_update': activity(event); break;
    case 'event_status':
    case 'call_event_status': {
      const status = event.status || event.state || 'received';
      const reason = event.reason || event.message || event.error || event.detail;
      const messages = { queued: 'Your request is queued with the voice engine.', rejected: 'The voice engine rejected this request.', dropped: 'The voice engine dropped this request.', accepted: 'The voice engine accepted this request.' };
      const message = messages[status] || 'The voice engine reported a request update.';
      activity({ title: 'Voice request status', message: reason ? `${message} ${typeof reason === 'string' ? reason : JSON.stringify(reason)}` : message, status });
      if (['queued', 'rejected', 'dropped'].includes(status)) notice(reason ? `${message} ${typeof reason === 'string' ? reason : JSON.stringify(reason)}` : message, ['rejected', 'dropped'].includes(status), { announce: false });
      break;
    }
    case 'app_status': if (event.message || event.detail || event.error) notice(event.message || event.detail || event.error, Boolean(event.error), { announce: false }); updateCapabilities(event.capabilities); break;
    case 'error': notice(event.message || event.error || 'There was a problem with the conversation.', true, { announce: false }); activity({ title: 'Conversation needs attention', message: event.message || event.error, status: 'error' }); break;
    case 'call_ended': stopConversation(false); break;
    default: break;
  }
}

function assertStartGeneration(generation) {
  if (generation !== state.startGeneration) throw new DOMException('Conversation start cancelled.', 'AbortError');
}
async function requestMicrophone(generation) {
  let expired = false;
  let timer;
  const request = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false }).then(stream => {
    if (expired || generation !== state.startGeneration) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Microphone request cancelled.', 'AbortError'); }
    return stream;
  });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Microphone permission did not finish. Choose Allow in your browser’s permission prompt, then press Start Sidekick to try again.')); }, 15000); });
  try { return await Promise.race([request, timeout]); }
  finally { clearTimeout(timer); }
}
async function startConversation({ listenOnly = false } = {}) {
  if (state.starting || state.running) return;
  const generation = ++state.startGeneration;
  state.starting = true; state.userInitiated = true; state.agentActive = false; state.listenOnly = listenOnly; $('talk-button').disabled = false; $('talk-button-label').textContent = 'Cancel'; notice(listenOnly ? 'Starting the listen-only judge mode. Your microphone will stay off.' : 'Please allow your microphone and location when your browser asks. Then tell me what you need.'); voiceStatus('connecting', 'Starting Sidekick.', 'You can cancel at any time.');
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || (!listenOnly && !navigator.mediaDevices?.getUserMedia)) throw new Error('This browser needs a secure connection and audio support. Try current Safari or Chrome.');
    state.context = new AudioContextClass();
    await state.context.resume();
    assertStartGeneration(generation);
    const session = state.session || await initialSession || await bootstrap();
    assertStartGeneration(generation);
    if (!session) throw new Error('Open your demo access link to connect to Sidekick.');
    if (!listenOnly) {
      const microphone = requestMicrophone(generation);
      shareLocation(false, { automatic: true, generation });
      const micStream = await microphone;
      assertStartGeneration(generation);
      state.micStream = micStream;
    }
    await state.context.audioWorklet.addModule('/pcm-worklet.js');
    assertStartGeneration(generation);
    state.micSource = listenOnly ? state.context.createConstantSource() : state.context.createMediaStreamSource(state.micStream);
    if (listenOnly) state.micSource.offset.value = 0;
    state.micNode = new AudioWorkletNode(state.context, 'sidekick-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    state.micSink = state.context.createGain(); state.micSink.gain.value = 0;
    state.micSource.connect(state.micNode); state.micNode.connect(state.micSink); state.micSink.connect(state.context.destination);
    if (listenOnly) state.micSource.start();
    state.greetingAcknowledged = false; state.running = true; state.muted = false; state.nextAudioAt = 0;
    state.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/voice`);
    state.socket.binaryType = 'arraybuffer';
    const thisSocket = state.socket;
    state.statusTimer = setInterval(() => { refreshCapabilities(); refreshDeviceLocation(); }, 20000);
    refreshCapabilities();
    if (state.micNode) state.micNode.port.onmessage = (message) => {
      if (state.socket === thisSocket && state.running && !state.muted && state.greetingAcknowledged && thisSocket.readyState === WebSocket.OPEN && thisSocket.bufferedAmount < 256000) thisSocket.send(message.data);
    };
    thisSocket.onopen = () => { if (state.socket === thisSocket) send({ type: 'start_call' }); else thisSocket.close(); };
    thisSocket.onmessage = (message) => { if (state.socket === thisSocket && typeof message.data === 'string') { try { const event = JSON.parse(message.data); Promise.resolve(handleEvent(event)).catch(error => { if (state.socket === thisSocket) notice(error.message, true); }); } catch {} } };
    thisSocket.onerror = () => { if (state.socket === thisSocket) notice('The voice connection ran into a problem. Stop and try again.', true); };
    thisSocket.onclose = () => { if (state.socket === thisSocket && state.running) { stopConversation(false); notice('The conversation has ended. Press Start Sidekick whenever you’re ready.'); } };
    $('talk-button-label').textContent = 'Stop'; $('mute-button').disabled = listenOnly; $('mute-button').hidden = listenOnly; $('mute-button').setAttribute('aria-pressed', 'false'); $('mute-button').textContent = 'Mute'; $('listen-only-button').disabled = true;
    $('test-tools').hidden = !listenOnly && !new URLSearchParams(location.search).has('test');
    if (listenOnly) { $('demo-evidence').open = true; $('test-tools').open = true; notice('Listen-only judge mode. Your microphone is off. Send a typed request in the judge view.'); }
    voiceStatus('connecting', 'Meeting your Sidekick', 'Waiting for the live Alebex greeting.');
  } catch (error) {
    if (generation !== state.startGeneration) return;
    const message = error.name === 'NotAllowedError' ? 'Microphone access was not allowed. Enable it in your browser’s site permissions, then press Start Sidekick again.' : error.message;
    stopConversation(false); voiceStatus('error', 'Let’s try again.', 'Press Start Sidekick when you’re ready.'); notice(message, true);
  } finally { if (generation === state.startGeneration) { state.starting = false; $('talk-button').disabled = false; } }
}
function stopConversation(end = true) {
  if (end) send({ type: 'end_call' });
  state.startGeneration++; state.starting = false; state.running = false; state.listenOnly = false; state.connected = false; state.agentActive = false; state.greetingAcknowledged = false; clearTimeout(state.markTimer);
  window.speechSynthesis?.cancel();
  clearInterval(state.silenceTimer); state.silenceTimer = null; clearInterval(state.statusTimer); state.statusTimer = null; state.locationRefreshPending = false;
  clearAudio(); state.marks.length = 0;
  if (state.socket) { const socket = state.socket; state.socket = null; socket.close(); }
  state.micStream?.getTracks().forEach(track => track.stop()); state.micStream = null;
  state.cameraGeneration++;
  state.cameraPending = null;
  state.cameraStream?.getTracks().forEach(track => track.stop()); state.cameraStream = null;
  $('camera-video').srcObject = null; $('camera-video').hidden = true;
  $('camera-button').disabled = false; $('camera-button').textContent = 'Turn on camera'; $('camera-button').setAttribute('aria-pressed', 'false');
  $('camera-empty').hidden = Boolean(state.uploaded); $('uploaded-image').hidden = !state.uploaded; $('camera-source').hidden = !state.uploaded; $('camera-source').textContent = state.uploadedSource === 'synthetic_fixture' ? 'Demonstration menu' : 'Selected photo'; $('demo-image-notice').hidden = !state.uploaded || state.uploadedSource !== 'synthetic_fixture'; $('camera-status').textContent = state.uploaded ? state.uploadedSource === 'synthetic_fixture' ? 'Demo menu' : 'Photo shared' : 'Camera off'; $('capture-button').disabled = !state.uploaded;
  try { state.micSource?.stop?.(); } catch {}
  for (const node of [state.micNode, state.micSource, state.micSink]) { try { node?.disconnect(); } catch {} }
  if (state.micNode) state.micNode.port.onmessage = null;
  state.micNode = state.micSource = state.micSink = null;
  if (state.context) state.context.close().catch(() => {}); state.context = null;
  $('talk-button').disabled = false; $('talk-button-label').textContent = 'Start Sidekick'; $('listen-only-button').disabled = false; $('mute-button').disabled = true; $('mute-button').hidden = true; $('mute-button').setAttribute('aria-pressed', 'false'); $('mute-button').textContent = 'Mute';
  $('connection-status').textContent = state.session ? 'Ready with Alebex' : 'Connection needed'; voiceStatus('ready', 'Ready when you are.', 'Start Sidekick. Then just say what you need.');
}

async function requestCamera() {
  const generation = ++state.cameraGeneration;
  let expired = false; let timer;
  const request = navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false }).then(stream => {
    if (expired || generation !== state.cameraGeneration) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Camera request cancelled.', 'AbortError'); }
    return stream;
  });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Camera permission did not finish. Choose Allow in your browser’s camera prompt, then ask Sidekick to look again.')); }, 15000); });
  try { return await Promise.race([request, timeout]); }
  finally { clearTimeout(timer); }
}
async function toggleCamera({ automatic = false } = {}) {
  state.userInitiated = true;
  if (state.cameraPending) return state.cameraPending;
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(track => track.stop()); state.cameraStream = null; $('camera-video').srcObject = null; $('camera-video').hidden = true;
    $('camera-button').textContent = 'Turn on camera'; $('camera-button').setAttribute('aria-pressed', 'false'); $('camera-status').textContent = state.uploaded ? state.uploadedSource === 'synthetic_fixture' ? 'Demo menu' : 'Photo shared' : 'Camera off';
    $('camera-empty').hidden = Boolean(state.uploaded); $('uploaded-image').hidden = !state.uploaded; $('camera-source').hidden = !state.uploaded; $('camera-source').textContent = state.uploadedSource === 'synthetic_fixture' ? 'Demonstration menu' : 'Selected photo'; $('demo-image-notice').hidden = !state.uploaded || state.uploadedSource !== 'synthetic_fixture'; $('capture-button').disabled = !state.uploaded; return;
  }
  $('camera-button').disabled = true;
  notice('Please allow your camera when the browser asks, and point your phone at what you want me to look at.');
  const cameraGeneration = state.cameraGeneration + 1;
  const cameraTask = (async () => {
    try {
      state.cameraStream = await requestCamera();
      $('camera-video').srcObject = state.cameraStream; $('camera-video').hidden = false; await $('camera-video').play();
      if (cameraGeneration !== state.cameraGeneration) throw new DOMException('Camera request cancelled.', 'AbortError');
      const readyDeadline = Date.now() + 2500;
      while (!$('camera-video').videoWidth && Date.now() < readyDeadline && cameraGeneration === state.cameraGeneration) await new Promise(resolve => setTimeout(resolve, 100));
      if (cameraGeneration !== state.cameraGeneration) throw new DOMException('Camera request cancelled.', 'AbortError');
      $('camera-empty').hidden = true; $('uploaded-image').hidden = true; $('camera-source').hidden = false; $('camera-source').textContent = 'Live camera'; $('demo-image-notice').hidden = true;
      $('camera-button').textContent = 'Turn off camera'; $('camera-button').setAttribute('aria-pressed', 'true'); $('camera-status').textContent = 'Camera on'; $('capture-button').disabled = false;
      notice(automatic ? 'Your camera is ready. If your previous request timed out, ask me to look again.' : 'Camera is on. Ask Sidekick what you want to know.');
      return state.cameraStream;
    } catch (error) { if (cameraGeneration !== state.cameraGeneration) throw error; const message = error.name === 'NotAllowedError' ? 'Camera access was not allowed. Enable camera access in your browser, then ask me to look again.' : error.message; notice(message, true); throw new Error(message); }
    finally { if (state.cameraPending === cameraTask) { $('camera-button').disabled = false; state.cameraPending = null; } }
  })();
  state.cameraPending = cameraTask;
  return state.cameraPending;
}
async function makeFrame(requestId) {
  let source, width, height, capturedAt, kind;
  if (state.cameraStream) { source = $('camera-video'); width = source.videoWidth; height = source.videoHeight; capturedAt = Date.now(); kind = 'camera'; }
  else if (state.uploaded) { source = $('uploaded-image'); width = source.naturalWidth; height = source.naturalHeight; capturedAt = Date.now(); kind = state.uploadedSource; }
  else throw new Error('Turn on your camera or share a photo first.');
  if (!width || !height) throw new Error('The camera image is not ready yet. Try again in a moment.');
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/jpeg', .75), capturedAt, requestId, source: kind };
}
async function answerSnapshot(event) {
  const generation = state.startGeneration;
  try { if (!state.cameraStream && !state.uploaded) await toggleCamera({ automatic: true }); if (generation !== state.startGeneration) return; await api('/api/frame', await makeFrame(event.requestId)); }
  catch (error) { if (generation !== state.startGeneration) return; await api('/api/frame', { requestId: event.requestId, error: state.cameraStream || state.uploaded ? 'capture_failed' : 'camera_off', message: error.message, capturedAt: Date.now() }).catch(() => {}); notice(error.message, true); }
}
async function manualCapture() {
  if (state.capturePending) return;
  state.capturePending = true; $('capture-button').disabled = true;
  try {
    const frame = await makeFrame(); await api('/api/frame', frame);
    const fixture = frame.source === 'synthetic_fixture';
    activity({ title: frame.source === 'camera' ? 'Fresh camera image shared' : fixture ? 'Demonstration menu shared' : 'Selected photo shared', message: fixture ? 'Synthetic demonstration image, not a live café menu.' : 'Shared only this image with Sidekick.', source: frame.source === 'camera' ? 'Device camera' : fixture ? 'Synthetic demo fixture' : 'User-selected photo', status: 'Ready for vision' });
    const question = $('vision-question').value.trim() || 'Describe what is in the latest camera image and read useful visible text.';
    if (send({ type: 'app_vision_question', question })) notice('Image shared. Sidekick is taking a look.');
    else notice('Image shared. Start a voice conversation, then ask about it.');
  } catch (error) { notice(error.message, true); }
  finally { state.capturePending = false; $('capture-button').disabled = !(state.cameraStream || state.uploaded); }
}
async function uploadImage(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { notice('Please select an image file.', true); return; }
  if (file.size > 20 * 1024 * 1024) { notice('Please choose an image smaller than 20 MB.', true); return; }
  const url = URL.createObjectURL(file);
  try {
    const img = $('uploaded-image'); img.src = url; await img.decode();
    if (state.uploaded) URL.revokeObjectURL(state.uploaded.url);
    state.uploaded = { url, capturedAt: Date.now() }; state.uploadedSource = 'upload';
    if (state.cameraStream) { state.cameraStream.getTracks().forEach(track => track.stop()); state.cameraStream = null; $('camera-video').srcObject = null; }
    $('camera-video').hidden = true; img.hidden = false; img.alt = 'Image you selected to share with Sidekick'; $('camera-empty').hidden = true; $('camera-source').hidden = false; $('camera-source').textContent = 'Selected photo'; $('demo-image-notice').hidden = true; $('camera-status').textContent = 'Photo shared'; $('camera-button').textContent = 'Turn on camera'; $('camera-button').setAttribute('aria-pressed', 'false'); $('capture-button').disabled = false;
    await manualCapture();
  } catch (error) { URL.revokeObjectURL(url); notice(`Could not read that image: ${error.message}`, true); }
}
async function loadDemoMenu() {
  $('demo-menu-button').disabled = true;
  try {
    const img = $('uploaded-image'); img.src = '/demo-menu.png'; await img.decode();
    if (state.uploaded?.url.startsWith('blob:')) URL.revokeObjectURL(state.uploaded.url);
    state.uploaded = { url: '/demo-menu.png', capturedAt: Date.now() }; state.uploadedSource = 'synthetic_fixture';
    if (state.cameraStream) { state.cameraStream.getTracks().forEach(track => track.stop()); state.cameraStream = null; $('camera-video').srcObject = null; }
    $('camera-video').hidden = true; img.hidden = false; img.alt = 'Synthetic demonstration café menu, not a live café menu'; $('camera-empty').hidden = true; $('camera-source').hidden = false; $('camera-source').textContent = 'Demonstration menu'; $('demo-image-notice').hidden = false; $('camera-status').textContent = 'Demo menu'; $('camera-button').textContent = 'Turn on camera'; $('camera-button').setAttribute('aria-pressed', 'false'); $('capture-button').disabled = false;
    if (!$('vision-question').value.trim()) $('vision-question').value = 'What decaf drink and price are shown?';
    notice('Demo menu loaded. Choose “Look at this” to ask Sidekick about this demonstration image.');
  } catch { notice('The demonstration menu could not be loaded. Please try again shortly.', true); }
  finally { $('demo-menu-button').disabled = false; }
}
async function shareLocation(demo = false, { automatic = false, generation, refresh = false } = {}) {
  if (!automatic) state.userInitiated = true;
  $('location-button').disabled = true; $('demo-location-button').disabled = true;
  try {
    let payload;
    if (demo) payload = { latitude: 49.2837, longitude: -123.1146, accuracy: 100, timestamp: Date.now(), source: 'demo' };
    else {
      if (!navigator.geolocation) throw new Error('Your location is unavailable. Tell Sidekick an address or nearby landmark instead.');
      if (!automatic) notice('Please allow your location when the browser asks.');
      let timer;
      const location = new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }));
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject({ code: 3 }), 15000); });
      let result;
      try { result = await Promise.race([location, timeout]); } finally { clearTimeout(timer); }
      if (automatic && generation !== state.startGeneration) return;
      payload = { latitude: result.coords.latitude, longitude: result.coords.longitude, accuracy: result.coords.accuracy, timestamp: result.timestamp, source: 'device' };
    }
    await api('/api/location', payload);
    if (automatic && generation !== state.startGeneration) return;
    state.locationSource = payload.source;
    if (payload.source === 'device') state.lastDeviceLocationAt = payload.timestamp;
    state.locationRetryAfter = 0;
    $('location-source').textContent = demo ? 'Demo location' : 'Device location';
    $('location-detail').textContent = demo ? 'Using the downtown Vancouver demo location. This is not your current GPS position.' : 'Your device location is shared for nearby searches.';
    $('location-accuracy').hidden = false; $('location-accuracy').textContent = `${demo ? 'Demo estimate' : 'GPS accuracy'}: about ${Math.round(payload.accuracy)} metres. Updated ${new Date(payload.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    if (!refresh) activity({ title: demo ? 'Vancouver demo location' : 'Device location shared', message: demo ? '49.2837, -123.1146. Explicit demo position for local discovery.' : `Location accuracy is about ${Math.round(payload.accuracy)} metres.`, source: demo ? 'Labelled demo coordinates' : 'Device geolocation', status: 'Available for nearby searches' }); if (!automatic) notice(demo ? 'Demo Vancouver location shared.' : 'Location shared. Ask me what’s nearby.');
  } catch (error) { if (automatic && generation !== state.startGeneration) return; state.locationRetryAfter = Date.now() + 60000; if (error.code === 1 || (!refresh && !demo)) state.locationSource = null; notice(error.code === 1 ? 'Your location wasn’t shared. Tell Sidekick an address or nearby landmark instead.' : error.code === 3 ? 'Your location took too long. Tell Sidekick an address or nearby landmark instead, or try again outside.' : error.message || 'Your location is unavailable. Tell Sidekick an address or nearby landmark instead.', true); }
  finally { $('location-button').disabled = false; $('demo-location-button').disabled = false; }
}
async function timsSetup(path, buttonId) {
  state.userInitiated = true;
  const button = $(buttonId); button.disabled = true;
  try {
    const result = await api(path, {});
    const message = result.spoken || 'Chrome connection status received.';
    notice(message);
    activity({ title: buttonId === 'tims-account-button' ? 'Connected Chrome profile' : 'Secure order review', spoken: message, status: result.status, source: 'Tim Hortons in your Chrome profile' });
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}
async function inspectWebsiteTask() {
  const button = $('inspect-task-button'); button.disabled = true;
  $('task-inspection-status').textContent = 'Reading the actual server task…';
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch('/api/task', { credentials: 'same-origin', headers, cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || result.error || `Task read failed (${response.status}).`);
    $('task-inspection-json').textContent = JSON.stringify(result, null, 2);
    $('task-inspection-details').open = true;
    $('task-inspection-status').textContent = `Actual server task loaded at ${new Date().toLocaleTimeString()}.`;
  } catch (error) { $('task-inspection-status').textContent = error.message || 'The task could not be read.'; }
  finally { button.disabled = false; }
}
function typedRequest(prompt) {
  if (!state.running || !send({ type: 'app_user_request', text: prompt, request: prompt })) { notice('Start a conversation first, then say this request or choose it again.'); $('talk-button').focus(); return; }
  activity({ title: 'Request from a demo control', message: prompt, source: 'User-selected prompt', status: 'Sent into live conversation' });
}
$('talk-button').addEventListener('click', () => { if (state.starting) { stopConversation(false); notice('Start cancelled. Press Start Sidekick whenever you’re ready.'); } else if (state.running) stopConversation(); else startConversation(); });
$('listen-only-button').addEventListener('click', () => { if (state.starting) stopConversation(false); startConversation({ listenOnly: true }); });
$('mute-button').addEventListener('click', () => { state.muted = !state.muted; state.micStream?.getAudioTracks().forEach(track => { track.enabled = !state.muted; }); $('mute-button').setAttribute('aria-pressed', String(state.muted)); $('mute-button').textContent = state.muted ? 'Unmute' : 'Mute'; refreshVoiceStatus(); });
$('camera-button').addEventListener('click', () => toggleCamera().catch(() => {}));
$('capture-button').addEventListener('click', manualCapture);
$('image-upload').addEventListener('change', event => uploadImage(event.target.files[0]));
$('demo-menu-button').addEventListener('click', loadDemoMenu);
$('location-button').addEventListener('click', () => shareLocation(false));
$('demo-location-button').addEventListener('click', () => shareLocation(true));
$('tims-account-button').addEventListener('click', () => timsSetup('/api/tims/account', 'tims-account-button'));
$('tims-review-button').addEventListener('click', () => timsSetup('/api/tims/review', 'tims-review-button'));
$('inspect-task-button').addEventListener('click', inspectWebsiteTask);
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => typedRequest(button.dataset.prompt)));
$('text-form').addEventListener('submit', event => { event.preventDefault(); const value = $('text-request').value.trim(); if (value) { typedRequest(value); $('text-request').value = ''; } });
document.addEventListener('keydown', event => { if (event.code === 'Space' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest('button,input,textarea,select,summary,a,[contenteditable="true"]')) { event.preventDefault(); $('talk-button').click(); } });
window.addEventListener('pagehide', () => { stopConversation(); state.cameraStream?.getTracks().forEach(track => track.stop()); });
