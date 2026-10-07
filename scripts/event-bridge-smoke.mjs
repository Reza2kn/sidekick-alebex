#!/usr/bin/env node
/** Bounded read-only event-path diagnostic: no microphone, synthetic speech, or phone. */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { ROOT, readConfig, redact } from '../lib/config.mjs';

const cfg = await readConfig();
const reportPath = join(ROOT, 'research', 'event-bridge-smoke.json');
const origin = 'http://localhost:4317';
const start = performance.now();
const elapsed = () => Math.round(performance.now() - start);
const safe = value => redact(String(value), cfg);
const report = { generatedAt: new Date().toISOString(), kind: 'silent_pcm_live_event_bridge_probe',
  boundedSeconds: 30, microphoneUsed: false, continuousSilence: true, eventStatuses: [], conversation: [],
  toolActivity: [], marks: [], errors: [], frameCounts: {},
  request: 'Find the closest public washroom near my chosen demo location.',
  caveat: 'Server protocol diagnostic with continuous silent PCM and simulated playback. It does not establish browser audibility or human listening quality.' };

let cookie;
async function post(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(path === '/api/session' ? { Authorization: `Bearer ${cfg.DEMO_ACCESS_TOKEN}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (path === '/api/session') cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!response.ok) throw new Error(`${path}: ${response.status}, ${safe(result.error || 'request failed')}`);
  return result;
}

await post('/api/session', {});
await post('/api/location', { latitude: 49.2837, longitude: -123.1146, accuracy: 100, timestamp: Date.now(), source: 'demo' });
const socket = new WebSocket('ws://localhost:4317/api/voice', { headers: { Cookie: cookie, Origin: origin } });
const timers = new Set();
let inputInterval, playhead = 0, ended = false, closed = false, eventSent = false, toolDoneAt, answerAt;
let resolveDone;
const done = new Promise(resolve => { resolveDone = resolve; });
const later = (fn, ms) => {
  const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer;
};
const send = message => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
const stop = reason => {
  if (ended) return;
  ended = true; report.stopReason = reason; report.endRequestedMs = elapsed(); send({ type: 'end_call' });
  later(() => { if (!closed) socket.close(1000); resolveDone(); }, 800);
};
const sendRequest = () => {
  if (eventSent || ended) return;
  eventSent = true; report.requestSentMs = elapsed();
  send({ type: 'app_user_request', text: report.request });
  console.log(JSON.stringify({ phase: 'request_sent', atMs: elapsed(), text: report.request }));
};
const acknowledge = mark => {
  if (mark.acknowledgedAtMs !== undefined) return;
  mark.acknowledgedAtMs = elapsed(); send({ type: 'mark', name: mark.name });
  if (mark.sequence === 1) later(sendRequest, 250);
  else if (toolDoneAt !== undefined && answerAt !== undefined && mark.receivedAtMs >= answerAt - 30) {
    report.responsePlaybackCompletedMs = elapsed(); later(() => stop('event_tool_reply_verified'), 100);
  }
};
socket.on('open', () => {
  report.socketOpenedMs = elapsed(); send({ type: 'start_call' });
  inputInterval = setInterval(() => {
    if (!ended && socket.readyState === WebSocket.OPEN) {
      socket.send(Buffer.alloc(640)); report.silentPcmFrames = (report.silentPcmFrames || 0) + 1;
    }
  }, 20);
});
socket.on('message', (raw, binary) => {
  if (binary) return;
  let frame;
  try { frame = JSON.parse(raw.toString()); } catch { report.errors.push('Invalid text frame.'); return; }
  const at = elapsed(); report.frameCounts[frame.type] = (report.frameCounts[frame.type] || 0) + 1;
  if (frame.type === 'audio') {
    const pcm = Buffer.from(frame.data || '', 'base64');
    report.audioBytes = (report.audioBytes || 0) + pcm.length;
    if (playhead <= at) playhead = at + 180;
    playhead += pcm.length / ((frame.sample_rate || 24000) * 2 / 1000);
  } else if (frame.type === 'mark') {
    const mark = { sequence: report.marks.length + 1, name: frame.name, receivedAtMs: at, playbackEndsAtMs: Math.round(playhead) };
    report.marks.push(mark); later(() => acknowledge(mark), Math.max(0, Math.ceil(playhead - at)));
  } else if (frame.type === 'clear_audio') {
    playhead = 0;
    for (const mark of report.marks) { if (mark.acknowledgedAtMs === undefined) mark.playbackCancelled = true; acknowledge(mark); }
  } else if (frame.type === 'event_status') {
    const item = { atMs: at };
    for (const key of ['eventId', 'status', 'name', 'reason', 'field', 'message', 'line']) if (frame[key] !== undefined) item[key] = safe(frame[key]);
    report.eventStatuses.push(item); console.log(JSON.stringify({ type: 'event_status', ...item }));
    if (['rejected', 'dropped'].includes(frame.status)) later(() => stop(`event_${frame.status}:${frame.reason || 'unspecified'}`), 1000);
  } else if (frame.type === 'conversation_message') {
    const role = frame.role || frame.message?.role;
    const content = frame.content || frame.text || frame.message?.content || frame.message?.text;
    if (typeof content === 'string') {
      const item = { atMs: at, role, content: safe(content).slice(0, 1800) };
      report.conversation.push(item); console.log(JSON.stringify({ type: 'conversation_message', ...item }));
      if (role === 'assistant' && toolDoneAt !== undefined && at >= toolDoneAt) answerAt = at;
    }
  } else if (frame.type === 'tool_activity') {
    const item = { atMs: at, tool: frame.tool, state: frame.state, spoken: safe(frame.spoken || '').slice(0, 1600),
      ...(frame.result ? { result: JSON.parse(safe(JSON.stringify(frame.result))) } : {}) };
    report.toolActivity.push(item); console.log(JSON.stringify({ type: 'tool_activity', ...item }));
    if (frame.tool === 'find_local_amenities' && frame.state === 'done') toolDoneAt = at;
    if (frame.state === 'error') { report.errors.push(item.spoken); stop('tool_error'); }
  } else if (frame.type === 'error' || (frame.type === 'app_status' && frame.error)) {
    report.errors.push(safe(frame.message || frame.error)); stop('bridge_error');
  } else if (frame.type === 'call_ended') stop('engine_call_ended');
});
socket.on('error', () => { report.errors.push('WebSocket bridge connection error.'); stop('socket_error'); });
socket.on('close', code => { closed = true; report.closeCode = code; if (!ended) report.stopReason = 'socket_closed'; resolveDone(); });
later(() => stop('bounded_deadline'), 30_000);
await done;
clearInterval(inputInterval); for (const timer of timers) clearTimeout(timer);
if (!closed) socket.close(1000);
report.elapsedMs = elapsed();
report.checks = {
  eventQueued: report.eventStatuses.some(item => item.status === 'queued'),
  eventSpoken: report.eventStatuses.some(item => item.status === 'spoken'),
  readOnlyToolSucceeded: report.toolActivity.some(item => item.tool === 'find_local_amenities' && item.state === 'done' && item.result?.ok),
  answerCommitted: answerAt !== undefined,
  playbackCompleted: report.responsePlaybackCompletedMs !== undefined,
  marksHeldCorrectly: report.marks.every(mark => mark.playbackCancelled || mark.acknowledgedAtMs >= mark.playbackEndsAtMs),
};
await mkdir(join(ROOT, 'research'), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ reportPath, elapsedMs: report.elapsedMs, stopReason: report.stopReason, checks: report.checks, errors: report.errors }, null, 2));
if (!report.checks.readOnlyToolSucceeded || !report.checks.playbackCompleted) process.exitCode = 1;
