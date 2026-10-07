#!/usr/bin/env node
/** One bounded synthetic-voice call through the running Sidekick HTTP/WS bridge. */
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { readConfig } from '../lib/config.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const base = 'http://localhost:4317';
const wavPath = join(root, '.local', 'bridge-smoke.wav');
const reportPath = join(root, 'research', 'bridge-smoke.json');
const questions = [
  { text: 'Look at the photo and tell me the decaf drink and price.', tool: 'look_at_camera' },
  ...(!process.argv.includes('--vision-only') ? [{ text: 'Find the closest public washroom near my chosen demo location.', tool: 'find_local_amenities' }] : []),
];
let cookie = '';
let sessionAccessToken = '';
const safe = text => String(text).replaceAll(sessionAccessToken || '\0', '[redacted]').replace(/(?:wt_|sk-or-v1-|whsec_)[A-Za-z0-9_-]+/g, '[redacted]')
  .replace(/sidekick_session=[A-Za-z0-9]+/g, 'sidekick_session=[redacted]')
  .replace(/https?:\/\/[^\s"<>]*\/voice-tools\/[^\s"<>]+/g, '[tool URL omitted]');

async function request(path, body) {
  const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}),
      ...(path === '/api/session' && sessionAccessToken ? { Authorization: `Bearer ${sessionAccessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const result = await res.json();
  if (path === '/api/session') cookie = res.headers.get('set-cookie')?.split(';')[0] || '';
  if (!res.ok) throw new Error(`${path} returned ${res.status}: ${safe(result.error || 'Request failed')}`);
  return result;
}

async function synthesize(text) {
  const dir = await mkdtemp(join(tmpdir(), 'sidekick-bridge-smoke-'));
  try {
    const source = join(dir, 'question.aiff'), target = join(dir, 'question.pcm');
    const said = spawnSync('/usr/bin/say', ['-o', source, text], { encoding: 'utf8', timeout: 10_000 });
    if (said.status !== 0) throw new Error('Synthetic speech preparation failed.');
    const converted = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-ac', '1', '-ar', '16000', '-f', 's16le', target], { encoding: 'utf8', timeout: 10_000 });
    if (converted.status !== 0) throw new Error('Synthetic PCM conversion failed.');
    return await readFile(target);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function wave(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function resultSummary(value = {}) {
  const result = {};
  for (const key of ['ok', 'status', 'available', 'code', 'error_code', 'category', 'distance_kind', 'fetched_at', 'latency_ms']) {
    if (['string', 'number', 'boolean'].includes(typeof value[key])) result[key] = value[key];
  }
  if (value.spoken) result.spoken = safe(value.spoken).slice(0, 1200);
  if (value.source) result.source = value.source;
  if (value.sources) result.sources = value.sources;
  if (value.observations) result.observations = value.observations.slice(0, 6);
  if (value.uncertainties) result.uncertainties = value.uncertainties.slice(0, 4);
  if (value.location) result.location = { latitude: value.location.latitude, longitude: value.location.longitude,
    source: value.location.source, label: value.location.label };
  if (value.places) result.places = value.places.slice(0, 3).map(place => ({ name: place.name,
    straight_line_distance_m: place.straight_line_distance_m, listed_hours: place.listed_hours }));
  return result;
}

async function runBridge(pcms, dataUrl) {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const report = {
    generatedAt: new Date().toISOString(), kind: 'http_websocket_tool_bridge_smoke', boundedSeconds: 70,
    input: { syntheticSpeech: true, sampleRate: 16000, format: 'pcm16', frameBytes: 640, frameMilliseconds: 20 },
    fixture: { path: join(root, '.local', 'vision-menu.png'), synthetic: true, imageUploadSource: 'upload' },
    chosenLocation: { latitude: 49.2837, longitude: -123.1146, accuracy: 100, source: 'demo' },
    questions: questions.map(item => ({ text: item.text, expectedTool: item.tool })),
    conversation: [], toolActivity: [], marks: [], errors: [], frameCounts: {}, timingMs: {},
    caveat: 'Server bridge with synthetic caller speech and simulated playback timing. Uploaded menu is a synthetic fixture; chosen location is demo coordinates. No microphone, browser playback, camera-device capture, human listening, or telephone call is tested.',
  };
  await request('/health');
  const session = await request('/api/session', {});
  if (!cookie) throw new Error('Session cookie was not issued.');
  report.capabilitiesAtStart = session.capabilities;
  await request('/api/location', { ...report.chosenLocation, timestamp: Date.now() });
  await request('/api/frame', { dataUrl, capturedAt: Date.now(), source: 'upload' });
  let turn = -1;
  let inputOffset = null;
  let inputComplete = false;
  let playhead = 0;
  let markSequence = 0;
  let workingTools = 0;
  let ending = false;
  let closed = false;
  let inputInterval;
  const chunks = [];
  const timers = new Set();
  const answer = questions.map(() => ({ toolDoneAt: null, assistantAt: null }));
  const ws = new WebSocket('ws://localhost:4317/api/voice', { headers: { Cookie: cookie, Origin: base } });
  let resolveCompletion;
  const completed = new Promise(resolve => { resolveCompletion = resolve; });
  const later = (fn, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay);
    timers.add(timer); return timer;
  };
  const send = frame => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); };
  const stop = reason => {
    if (ending) return;
    ending = true; report.stopReason = reason; report.timingMs.endRequested = elapsed();
    send({ type: 'end_call' });
    later(() => { if (!closed) ws.close(1000); resolveCompletion(); }, 900);
  };
  const startQuestion = index => {
    if (ending) return;
    turn = index; inputOffset = 0; inputComplete = false;
    report.questions[index].startedAtMs = elapsed();
    console.log(JSON.stringify({ phase: 'synthetic_question', index: index + 1, text: questions[index].text }));
  };
  const ack = mark => {
    if (mark.acknowledgedAtMs !== undefined) return;
    mark.acknowledgedAtMs = elapsed();
    send({ type: 'mark', name: mark.name });
    if (mark.sequence === 1 && turn === -1) startQuestion(0);
    else if (turn >= 0 && inputComplete && answer[turn].toolDoneAt !== null && answer[turn].assistantAt !== null &&
      mark.receivedAtMs >= answer[turn].assistantAt - 20) {
      report.questions[turn].answerPlaybackCompleteMs = elapsed();
      if (turn + 1 < questions.length) later(() => startQuestion(turn + 1), 450);
      else later(() => stop('requested_tool_responses_completed'), 300);
    }
  };
  ws.on('open', () => {
    report.timingMs.socketOpened = elapsed(); send({ type: 'start_call' });
    inputInterval = setInterval(() => {
      if (ending || ws.readyState !== WebSocket.OPEN) return;
      const frame = Buffer.alloc(640);
      if (turn >= 0 && inputOffset !== null && !inputComplete) {
        pcms[turn].copy(frame, 0, inputOffset, inputOffset + 640); inputOffset += 640;
        if (inputOffset >= pcms[turn].length) {
          inputComplete = true; report.questions[turn].inputCompleteMs = elapsed();
        }
      }
      ws.send(frame);
    }, 20);
  });
  ws.on('message', (raw, binary) => {
    if (binary) { report.frameCounts.unexpected_binary = (report.frameCounts.unexpected_binary || 0) + 1; return; }
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { report.errors.push('Invalid bridge text frame.'); stop('invalid_frame'); return; }
    const at = elapsed();
    report.frameCounts[frame.type || 'unknown'] = (report.frameCounts[frame.type || 'unknown'] || 0) + 1;
    if (frame.type === 'audio') {
      if ((frame.sample_rate && frame.sample_rate !== 24000) || (frame.format && frame.format !== 'pcm16')) {
        report.errors.push('Unexpected agent audio format.'); stop('invalid_audio'); return;
      }
      const audio = Buffer.from(frame.data || '', 'base64'); chunks.push(audio);
      report.timingMs.firstAgentAudio ??= at;
      if (playhead <= at) playhead = at + 180;
      playhead += audio.length / 48;
    } else if (frame.type === 'mark') {
      const mark = { sequence: ++markSequence, name: frame.name, receivedAtMs: at, playbackEndsAtMs: Math.round(playhead) };
      report.marks.push(mark); later(() => ack(mark), Math.max(0, Math.ceil(playhead - at)));
    } else if (frame.type === 'clear_audio') {
      playhead = 0;
      for (const mark of report.marks) {
        if (mark.acknowledgedAtMs === undefined) mark.playbackCancelled = true;
        ack(mark);
      }
    } else if (frame.type === 'call_started') report.timingMs.callStarted = at;
    else if (frame.type === 'conversation_message') {
      const role = frame.role || frame.message?.role;
      const content = frame.content || frame.text || frame.message?.content || frame.message?.text;
      if (typeof content === 'string') {
        report.conversation.push({ atMs: at, role, content: safe(content).slice(0, 1600) });
        if (role === 'assistant' && turn >= 0 && answer[turn].toolDoneAt !== null && at >= answer[turn].toolDoneAt) {
          answer[turn].assistantAt = at; report.questions[turn].answerText = safe(content).slice(0, 1600);
          report.questions[turn].answerCommittedMs = at;
        }
      }
    } else if (frame.type === 'tool_activity') {
      report.toolActivity.push({ atMs: at, tool: frame.tool, state: frame.state, spoken: safe(frame.spoken || '').slice(0, 1200),
        ...(frame.result ? { result: resultSummary(frame.result) } : {}) });
      console.log(JSON.stringify({ phase: 'tool_activity', tool: frame.tool, state: frame.state }));
      if (frame.state === 'working' && ++workingTools > 2) { stop('two_tool_budget_reached'); return; }
      if (['start_assistance_call', 'prepare_assistance_call'].includes(frame.tool)) { report.errors.push('Unexpected phone tool in read-only smoke.'); stop('unexpected_phone_tool'); return; }
      if (turn >= 0 && frame.tool === questions[turn].tool && frame.state === 'done') {
        answer[turn].toolDoneAt = at;
        report.questions[turn].toolDoneMs = at;
        report.questions[turn].toolOk = frame.result?.ok === true;
        if (frame.result?.ok === false) stop('tool_reported_failure');
      }
      if (frame.state === 'error') { report.errors.push(safe(frame.spoken || 'Tool error.')); stop('tool_error'); }
    } else if (frame.type === 'snapshot_request') {
      report.snapshotRefreshes = (report.snapshotRefreshes || 0) + 1;
      request('/api/frame', { requestId: frame.requestId, dataUrl, capturedAt: Date.now(), source: 'upload' })
        .catch(error => { report.errors.push(safe(error.message)); stop('snapshot_upload_failed'); });
    } else if (frame.type === 'error' || (frame.type === 'app_status' && frame.error)) {
      report.errors.push(safe(frame.message || frame.error || 'Voice bridge error.')); stop('bridge_error');
    } else if (frame.type === 'call_ended') stop('engine_call_ended');
  });
  ws.on('error', () => { report.errors.push('WebSocket bridge connection error.'); stop('socket_error'); });
  ws.on('close', code => { closed = true; report.closeCode = code; if (!ending) report.stopReason = 'socket_closed'; resolveCompletion(); });
  later(() => stop('bounded_deadline'), 70_000);
  await completed;
  clearInterval(inputInterval); for (const timer of timers) clearTimeout(timer);
  if (!closed) ws.close(1000);
  report.elapsedMs = elapsed();
  const pcm = Buffer.concat(chunks);
  await mkdir(dirname(wavPath), { recursive: true });
  if (pcm.length) await writeFile(wavPath, wave(pcm), { mode: 0o600 });
  report.agentAudio = { path: pcm.length ? wavPath : null, sampleRate: 24000, channels: 1,
    audioBytes: pcm.length, audioChunks: chunks.length, audioSeconds: Number((pcm.length / 48000).toFixed(3)),
    note: 'Agent chunks concatenated without inter-turn silence; simulated timing only.' };
  const task = await request('/api/task').catch(() => ({ status: 'unavailable' }));
  report.taskStatusAfterCall = task.status;
  report.checks = {
    callStarted: Boolean(report.frameCounts.call_started),
    marksNotEchoedEarly: report.marks.every(mark => mark.playbackCancelled || mark.acknowledgedAtMs >= mark.playbackEndsAtMs),
    visionToolConfirmed: report.toolActivity.some(item => item.tool === 'look_at_camera' && item.state === 'done' && item.result?.ok),
    decafPriceGrounded: report.toolActivity.some(item => item.tool === 'look_at_camera' && item.result?.observations?.some(value => /4\.75/.test(value))),
    nearbyToolConfirmed: report.toolActivity.some(item => ['find_nearby_places', 'find_local_amenities'].includes(item.tool) && item.state === 'done' && item.result?.ok),
    noPhoneTask: task.status === 'none',
    requestedAnswersSpoken: report.questions.every(item => Boolean(item.answerText && item.answerPlaybackCompleteMs)),
    uploadedImageLabelSpoken: /uploaded (?:image|photo|picture)/i.test(report.questions[0]?.answerText || ''),
    syntheticMenuLabelSpoken: /demo|demonstration|fixture/i.test(report.questions[0]?.answerText || ''),
    demoLocationLabelSpoken: questions.length < 2 || /demo/i.test(report.questions[1]?.answerText || ''),
    straightLineDistanceSpoken: questions.length < 2 || /straight.line/i.test(report.questions[1]?.answerText || ''),
    washroomAvailabilityLimitSpoken: questions.length < 2 || /not verified|haven.t verified|can.t verify|unlocked/i.test(report.questions[1]?.answerText || ''),
  };
  return report;
}

async function main() {
  sessionAccessToken = (await readConfig()).DEMO_ACCESS_TOKEN || '';
  let previous;
  try {
    const prior = JSON.parse(await readFile(reportPath, 'utf8'));
    previous = { generatedAt: prior.generatedAt, elapsedMs: prior.elapsedMs,
      visionModel: prior.toolActivity?.find(item => item.tool === 'look_at_camera' && item.result)?.result.source?.model,
      checks: prior.checks, answers: prior.questions?.map(item => item.answerText) };
  } catch {}
  const pcms = [];
  for (const question of questions) pcms.push(await synthesize(question.text));
  const fixture = await readFile(join(root, '.local', 'vision-menu.png'));
  const report = await runBridge(pcms, `data:image/png;base64,${fixture.toString('base64')}`);
  if (previous) report.previousBridgeSummary = previous;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ reportPath, elapsedMs: report.elapsedMs, stopReason: report.stopReason,
    checks: report.checks, questions: report.questions, toolActivity: report.toolActivity,
    errors: report.errors, caveat: report.caveat }, null, 2));
  if (report.errors.length || !report.checks.visionToolConfirmed || !report.checks.requestedAnswersSpoken) process.exitCode = 1;
}

main().catch(error => { console.error(safe(error.message)); process.exitCode = 1; });
