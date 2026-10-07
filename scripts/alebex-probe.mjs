#!/usr/bin/env node
/**
 * Read-only account probe by default. --voice creates/reuses one dedicated
 * Sidekick agent and runs one bounded server-protocol smoke call. Never dials.
 * Requires Node 22, and macOS say + ffmpeg for the optional synthetic question.
 */
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const reportPath = join(root, 'research', 'voice-smoke.json');
const wavPath = join(root, '.local', 'voice-smoke.wav');
const agentName = 'Sidekick — Vancouver accessibility demo';
const question = 'Can you see my camera or tell where I am right now?';
const voiceMode = process.argv.includes('--voice');
let secret = '';

async function loadEnv() {
  let file = '';
  try { file = await readFile(join(root, '.env.local'), 'utf8'); } catch {}
  for (const line of file.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
  secret = process.env.ALEBEX_API_KEY || '';
  if (!secret) throw new Error('ALEBEX_API_KEY is missing from server environment or .env.local.');
}

function safe(value) {
  return String(value).replaceAll(secret || '\0', '[redacted]')
    .replace(/wt_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(?:https?|wss?):\/\/[^\s"<>]+/g, '[url omitted]');
}

async function api(method, path, body) {
  const base = (process.env.ALEBEX_API_URL || 'https://api.alebex.ai/api/v1').replace(/\/$/, '');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) {
    const code = result.error?.code || `HTTP_${response.status}`;
    throw new Error(`${code}: ${safe(result.error?.message || result.detail || 'Request failed')}`);
  }
  return result;
}

async function listAgents() {
  const agents = [];
  let cursor;
  do {
    const page = await api('GET', `/public/agents?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    agents.push(...page.items);
    cursor = page.nextCursor;
    if (agents.length > 10000) throw new Error('Agent listing unexpectedly exceeded ten thousand entries.');
  } while (cursor);
  return agents;
}

async function syntheticQuestion() {
  const temp = await mkdtemp(join(tmpdir(), 'sidekick-voice-probe-'));
  try {
    const aiff = join(temp, 'question.aiff');
    const pcm = join(temp, 'question.pcm');
    const said = spawnSync('/usr/bin/say', ['-o', aiff, question], { encoding: 'utf8', timeout: 10000 });
    if (said.status !== 0) return { error: 'Local speech synthesis unavailable; greeting-only smoke.' };
    const converted = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff,
      '-ac', '1', '-ar', '16000', '-f', 's16le', pcm], { encoding: 'utf8', timeout: 10000 });
    if (converted.status !== 0) return { error: 'PCM conversion unavailable; greeting-only smoke.' };
    return { pcm: await readFile(pcm), text: question };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

function wave(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function transcriptFields(frame) {
  const result = {};
  for (const field of ['role', 'speaker', 'text', 'transcript', 'content', 'final', 'is_final']) {
    if (typeof frame[field] === 'string') result[field] = safe(frame[field]).slice(0, 2000);
    else if (typeof frame[field] === 'boolean') result[field] = frame[field];
  }
  for (const field of ['message', 'data']) {
    if (typeof frame[field] === 'string' && frame.type !== 'audio') result[field] = safe(frame[field]).slice(0, 2000);
    else if (frame[field] && typeof frame[field] === 'object') result[field] = transcriptFields(frame[field]);
  }
  return result;
}

async function smoke(agent, synthesized) {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const audio = [];
  const frameCounts = {};
  const timeline = [];
  const transcripts = [];
  const marks = [];
  const timers = new Set();
  const output = {
    kind: 'server_protocol_smoke', maxCallSeconds: 35,
    caveat: 'Synthetic caller and simulated output playback timing. This does not verify a microphone, browser playback, interruptions, accessibility usability, or human listening quality.',
    input: { format: 'pcm16', sampleRate: 16000, channels: 1, frameBytes: 640, frameMilliseconds: 20,
      syntheticQuestion: synthesized.text || null, preparationNote: synthesized.error || null },
    output: { format: 'pcm16', sampleRate: 24000, channels: 1 },
    latenciesMs: {}, frameCounts, timeline, transcripts, marks, errors: [],
  };
  let playhead = 0;
  let inputCursor = null;
  let inputDone = false;
  let inputInterval;
  let ending = false;
  let closed = false;
  let markCount = 0;
  let framesSent = 0;
  let silentFramesSent = 0;
  let resolveCompletion;
  let queue = Promise.resolve();
  const completed = new Promise(resolve => { resolveCompletion = resolve; });
  const engine = new URL(process.env.ALEBEX_ENGINE_URL || 'https://api.voice.alebex.ai');
  engine.protocol = 'wss:'; engine.pathname = '/public/ws/call'; engine.search = ''; engine.hash = '';
  const ws = new WebSocket(engine, `alebex.token.${secret}`);
  const later = (fn, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay);
    timers.add(timer); return timer;
  };
  const send = frame => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); };
  const shutdown = reason => {
    if (ending) return;
    ending = true;
    output.stopReason = reason;
    timeline.push({ atMs: elapsed(), type: 'client_end_call', reason });
    send({ type: 'end_call' });
    later(() => { if (!closed) ws.close(1000); resolveCompletion(); }, 800);
  };
  const acknowledge = record => {
    if (record.acknowledgedAtMs !== undefined) return;
    record.acknowledgedAtMs = elapsed();
    send({ type: 'mark', name: record.name });
    timeline.push({ atMs: elapsed(), type: 'client_mark_ack', sequence: record.sequence });
    if (record.sequence === 1) {
      output.latenciesMs.greetingPlaybackComplete = elapsed();
      if (synthesized.pcm) {
        inputCursor = 0;
        output.latenciesMs.syntheticQuestionStart = elapsed();
      } else shutdown('greeting_completed');
    } else if (inputDone) later(() => shutdown('response_playback_completed'), 250);
  };
  const processFrame = frame => {
    frameCounts[frame.type || 'unknown'] = (frameCounts[frame.type || 'unknown'] || 0) + 1;
    const at = elapsed();
    if (frame.type === 'audio') {
      const pcm = Buffer.from(frame.data || '', 'base64');
      if ((frame.sample_rate && frame.sample_rate !== 24000) || (frame.format && frame.format !== 'pcm16')) {
        output.errors.push('Unexpected output audio format or sample rate.');
        shutdown('unexpected_audio_format'); return;
      }
      audio.push(pcm);
      if (output.latenciesMs.firstAudio === undefined) output.latenciesMs.firstAudio = at;
      if (inputDone && output.latenciesMs.responseFirstAudio === undefined) {
        output.latenciesMs.responseFirstAudio = at;
        output.latenciesMs.responseAfterSyntheticQuestion = at - output.latenciesMs.syntheticQuestionEnd;
      }
      if (playhead <= at) playhead = at + 180;
      playhead += pcm.length / 48;
      return;
    }
    timeline.push({ atMs: at, type: frame.type || 'unknown' });
    if (frame.type === 'call_started') {
      output.callId = frame.call_id || frame.callId || null;
      output.latenciesMs.callStarted = at;
    } else if (frame.type === 'transcript' || frame.type === 'conversation_message') {
      transcripts.push({ atMs: at, type: frame.type, ...transcriptFields(frame) });
    } else if (frame.type === 'mark') {
      const record = { sequence: ++markCount, name: frame.name, receivedAtMs: at,
        simulatedPlaybackEndsAtMs: Math.round(playhead), acknowledgedAtMs: undefined };
      marks.push(record);
      later(() => acknowledge(record), Math.max(0, Math.ceil(playhead - at)));
    } else if (frame.type === 'clear_audio') {
      playhead = 0;
      for (const record of marks) acknowledge(record);
    } else if (frame.type === 'call_ended') {
      output.engineEndedReason = safe(frame.reason || 'unspecified');
      shutdown('engine_call_ended');
    } else if (frame.type === 'error') {
      output.errors.push({ code: safe(frame.code || 'unspecified'), message: safe(frame.message || '') });
      shutdown('engine_error');
    }
  };
  ws.addEventListener('open', () => {
    output.latenciesMs.socketOpened = elapsed();
    send({ type: 'start_call', agent: { id: agent.id },
      context: 'This is a developer protocol smoke call on Wednesday, October seventh, twenty twenty-six, Pacific time. No camera image, device location, or external tools are connected in this call.' });
    timeline.push({ atMs: elapsed(), type: 'client_start_call' });
    inputInterval = setInterval(() => {
      if (ending || ws.readyState !== WebSocket.OPEN) return;
      const frame = Buffer.alloc(640);
      if (inputCursor !== null && !inputDone) {
        synthesized.pcm.copy(frame, 0, inputCursor, inputCursor + 640);
        inputCursor += 640; framesSent++;
        if (inputCursor >= synthesized.pcm.length) {
          inputDone = true;
          output.latenciesMs.syntheticQuestionEnd = elapsed();
          timeline.push({ atMs: elapsed(), type: 'client_synthetic_question_completed' });
        }
      } else silentFramesSent++;
      ws.send(frame);
    }, 20);
  });
  ws.addEventListener('message', event => {
    queue = queue.then(async () => {
      if (typeof event.data !== 'string') {
        frameCounts.unexpected_binary = (frameCounts.unexpected_binary || 0) + 1;
        return;
      }
      try { processFrame(JSON.parse(event.data)); }
      catch { output.errors.push('Unparseable server text frame.'); shutdown('bad_server_frame'); }
    });
  });
  ws.addEventListener('error', () => { output.errors.push('WebSocket connection error.'); shutdown('socket_error'); });
  ws.addEventListener('close', event => {
    closed = true; output.closeCode = event.code;
    if (!ending) output.stopReason = 'socket_closed';
    resolveCompletion();
  });
  later(() => shutdown('bounded_deadline'), 35000);
  await completed;
  clearInterval(inputInterval);
  for (const timer of timers) clearTimeout(timer);
  await queue;
  if (!closed) ws.close(1000);
  output.elapsedMs = elapsed();
  output.input.syntheticFramesSent = framesSent;
  output.input.silentFramesSent = silentFramesSent;
  output.output.audioChunks = audio.length;
  output.output.audioBytes = audio.reduce((total, chunk) => total + chunk.length, 0);
  output.output.audioSeconds = Number((output.output.audioBytes / 48000).toFixed(3));
  output.verified = {
    callStarted: Boolean(frameCounts.call_started),
    receivedAgentAudio: audio.length > 0,
    greetingMarkAcknowledgedAfterPlayback: Boolean(marks[0]?.acknowledgedAtMs !== undefined &&
      marks[0].acknowledgedAtMs >= marks[0].simulatedPlaybackEndsAtMs),
    syntheticQuestionStreamed: inputDone,
    responseAudioReceived: output.latenciesMs.responseFirstAudio !== undefined,
  };
  if (audio.length) {
    await mkdir(dirname(wavPath), { recursive: true });
    await writeFile(wavPath, wave(Buffer.concat(audio)), { mode: 0o600 });
    output.output.wavePath = wavPath;
    output.output.waveNote = 'Agent chunks concatenated without inter-turn silence; not a full call recording.';
  }
  return output;
}

async function main() {
  await loadEnv();
  const [voices, agents] = await Promise.all([api('GET', '/public/voices'), listAgents()]);
  const selectedVoice = voices.find(v => v.voiceId === 'd5301370-9cc8-4a68-9740-470be0eef561') ||
    voices.find(v => v.name === 'Natalie' && v.language === 'en');
  if (!selectedVoice) throw new Error('Neither Julian nor Natalie is available in the account voice catalog.');
  let agent = agents.find(a => a.name === agentName);
  if (!voiceMode) {
    console.log(JSON.stringify({ mode: 'read_only', agentCount: agents.length, voiceCount: voices.length,
      dedicatedAgent: agent ? { id: agent.id, name: agent.name } : null,
      selectedVoice: { id: selectedVoice.voiceId, name: selectedVoice.name, description: selectedVoice.description },
      next: 'Use --voice to create/reuse Sidekick and run one bounded server-protocol call.' }, null, 2));
    return;
  }
  await mkdir(dirname(reportPath), { recursive: true });
  const prompt = (await readFile(join(root, 'prompts', 'sidekick-bootstrap.md'), 'utf8')).trim();
  const config = {
    name: agentName, prompt, firstMessage: 'Hi, I’m Sidekick. What would you like help with?',
    brainTier: 'premium', temperature: 0.5, maxTokens: 500,
    voices: [{ voiceId: selectedVoice.voiceId, language: 'en', speed: 1 }],
    behaviour: { turnEnd: 'fast', allowEndCall: true, idlePrompt: false, callEvents: true,
      backgroundVolume: 0, callLimitMinutes: 5 },
    opening: { speaksFirst: true, strictFirstMessage: true, callerFirstWaitMs: 2500 }, toolIds: [],
  };
  const existed = Boolean(agent);
  if (agent) agent = await api('GET', `/public/agents/${agent.id}`);
  else agent = await api('POST', '/public/agents', config);
  // A reused dedicated agent is left intact so later integration work is not overwritten.
  const report = {
    generatedAt: new Date().toISOString(), agent: { id: agent.id, name: agent.name, createdByThisRun: !existed,
      brainTier: agent.brainTier, voices: agent.voices, behaviour: agent.behaviour,
      firstMessage: agent.firstMessage },
    purpose: 'Alebex server voice and truthful capability bootstrap; no telephone call or external action.',
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const synthesized = await syntheticQuestion();
  try { report.smoke = await smoke(agent, synthesized); }
  catch (error) { report.smoke = { failed: true, error: safe(error.message) }; }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ agent: { id: agent.id, name: agent.name, createdByThisRun: !existed },
    verified: report.smoke.verified, elapsedMs: report.smoke.elapsedMs,
    latenciesMs: report.smoke.latenciesMs, frameCounts: report.smoke.frameCounts,
    conversation: report.smoke.transcripts?.filter(frame => frame.type === 'conversation_message'),
    errors: report.smoke.errors || [report.smoke.error].filter(Boolean),
    audio: report.smoke.output, reportPath, caveat: report.smoke.caveat }, null, 2));
  if (report.smoke.failed || report.smoke.errors?.length) process.exitCode = 1;
}

main().catch(error => { console.error(safe(error.message)); process.exitCode = 1; });
