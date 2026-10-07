#!/usr/bin/env node
/**
 * One authorized human-help call through Sidekick's real HTTP/WebSocket bridge.
 * Default invocation is held and performs no network requests or synthesis.
 * Root must explicitly authorize execution: node scripts/phone-bridge-smoke.mjs --go
 * Never use this script to call a business. It has no direct phone API calls.
 */
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { ROOT, readConfig, redact } from '../lib/config.mjs';

const QUESTIONS = [
  { stage: 'request', text: 'Call my human and ask what coffee they want for the demo.' },
  { stage: 'confirmation', text: 'Yes, go ahead.' },
  { stage: 'washroom', text: 'While that call is happening, find the closest public washroom near my chosen demo location.' },
  { stage: 'outcome', text: 'What did my human say on the phone call?' },
];
const HUMAN_TARGET = 'your configured human';
const JOB_WAIT_MS = 90_000;
const SESSION_WAIT_MS = 135_000;
const reportPath = join(ROOT, 'research', 'phone-bridge-smoke.json');
const wavPath = join(ROOT, '.local', 'phone-bridge-smoke.wav');
const reportDirectory = join(ROOT, '.local', 'call-reports');

function wave(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function synthesize(text) {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-human-smoke-'));
  try {
    const source = join(directory, 'speech.aiff'), target = join(directory, 'speech.pcm');
    const spoken = spawnSync('/usr/bin/say', ['-o', source, text], { encoding: 'utf8', timeout: 10_000 });
    if (spoken.status !== 0) throw new Error('Synthetic speech preparation failed.');
    const converted = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-ac', '1', '-ar', '16000', '-f', 's16le', target], { encoding: 'utf8', timeout: 10_000 });
    if (converted.status !== 0) throw new Error('Synthetic PCM conversion failed.');
    return await readFile(target);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const normalize = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const terminal = status => ['answered', 'accepted', 'declined', 'unknown', 'unanswered', 'failed'].includes(status);
const answered = task => ['answered', 'accepted', 'declined'].includes(task?.status) &&
  task.source === 'Signed Alebex call transcript' && typeof task.supporting_quote === 'string' && task.supporting_quote.trim().length > 1;

async function main() {
  if (!process.argv.includes('--go')) {
    console.log(JSON.stringify({ status: 'held', outboundCalls: 0, networkRequests: 0,
      reason: 'Awaiting explicit root GO after phone carrier upgrade. The --go flag is required.',
      commandAfterAuthorization: 'node scripts/phone-bridge-smoke.mjs --go' }));
    return;
  }
  const cfg = await readConfig();
  if (!/^\+\d{8,15}$/.test(cfg.DEMO_HUMAN_PHONE || '')) throw new Error('The configured human destination is unavailable.');
  const port = Number(cfg.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local server port.');
  const base = `http://localhost:${port}`;
  let cookie = '';
  const safe = value => {
    let text = redact(value, cfg);
    for (const privateValue of [cfg.DEMO_HUMAN_PHONE, cfg.TWILIO_PHONE_NUMBER, cfg.TWILIO_ACCOUNT_SID, cookie]) {
      if (privateValue) text = text.replaceAll(privateValue, '[redacted]');
    }
    return text.replace(/sidekick_session=[A-Za-z0-9]+/g, 'sidekick_session=[redacted]')
      .replace(/https?:\/\/[^\s"<>]*\/voice-tools\/[^\s"<>]+/g, '[tool URL omitted]');
  };
  const request = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}),
        ...(path === '/api/session' ? { Authorization: `Bearer ${cfg.DEMO_ACCESS_TOKEN || ''}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (path === '/api/session') cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
    if (!response.ok) throw new Error(`${path} returned ${response.status}: ${safe(result.error || 'Request failed')}`);
    return result;
  };
  const filesBefore = new Set(await readdir(reportDirectory).catch(() => []));
  const health = await request('/health');
  if (!health.phoneReady) throw new Error('The running server reports phone calling unavailable.');
  const session = await request('/api/session', {});
  if (!cookie || !session.capabilities?.phone) throw new Error('An authenticated phone-capable session was not issued.');
  if ((await request('/api/task')).status !== 'none') throw new Error('The new test session already has a phone task.');
  const location = { latitude: 49.2837, longitude: -123.1146, accuracy: 100, source: 'demo', timestamp: Date.now() };
  await request('/api/location', location);
  const pcms = await Promise.all(QUESTIONS.map(question => synthesize(question.text)));
  const start = performance.now(), startedAt = Date.now();
  const elapsed = () => Math.round(performance.now() - start);
  const report = {
    generatedAt: new Date().toISOString(), kind: 'synthetic_voice_human_help_confirmation_and_outcome',
    authorization: 'Explicit root GO required; configured builder-owned human number only',
    destination: 'configured human; number omitted', forbiddenDestinations: 'all businesses and arbitrary numbers',
    input: { syntheticSpeech: true, format: 'pcm16', sampleRate: 16000, frameBytes: 640, frameMilliseconds: 20 },
    chosenLocation: location, jobWaitBoundSeconds: 90, sessionWaitBoundSeconds: 135,
    questions: QUESTIONS.map(question => ({ ...question })),
    conversation: [], tools: [], jobUpdates: [], marks: [], errors: [], timingMs: {},
    caveat: 'Real Alebex server bridge and, only after GO, a real outbound call. Caller speech and playback timing are synthetic. The chosen location is a demo fixture. This does not verify browser microphone, physical camera, speaker playback, or human listening to the web assistant.',
  };
  let turn = -1, inputOffset = 0, inputComplete = false;
  let playhead = 0, markSequence = 0, ending = false, closed = false;
  let inputInterval, pollInterval, pollBusy = false;
  let preparedDraft = null, preparationAssistantAt = null, queuedAssistantAt = null, washroomAssistantAt = null, outcomeAssistantAt = null;
  let task = null, taskQueuedAt = null, jobTerminalAt = null, outcomeRequested = false;
  let washroomToolAt = null, taskStatusToolAt = null;
  let confirmationMark = null;
  const toolCounts = new Map(), timers = new Set(), audioChunks = [];
  const ws = new WebSocket(`ws://localhost:${port}/api/voice`, { headers: { Cookie: cookie, Origin: base } });
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const later = (callback, milliseconds) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, Math.max(0, milliseconds));
    timers.add(timer); return timer;
  };
  const send = value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const stop = reason => {
    if (ending) return;
    ending = true; report.stopReason = reason; report.timingMs.stopRequested = elapsed();
    send({ type: 'end_call' });
    later(() => { if (!closed) ws.close(1000); resolveDone(); }, 900);
  };
  const fail = (reason, message) => { report.errors.push(safe(message)); stop(reason); };
  const feed = index => {
    if (ending) return;
    if (index === 1 && (!preparedDraft || !confirmationMark || confirmationMark.playbackCancelled)) {
      fail('confirmation_guard', 'The exact human-only draft was not fully spoken and acknowledged.'); return;
    }
    turn = index; inputOffset = 0; inputComplete = false;
    report.questions[index].startedAtMs = elapsed();
    console.log(JSON.stringify({ phase: 'synthetic_question', stage: QUESTIONS[index].stage, text: QUESTIONS[index].text }));
  };
  const askOutcome = () => {
    if (ending || outcomeRequested || !jobTerminalAt || !report.questions[2].playbackCompletedAtMs) return;
    if (!answered(task)) { fail('unverified_phone_outcome', 'The phone task ended without a transcript-grounded human answer.'); return; }
    outcomeRequested = true; later(() => feed(3), 500);
  };
  const acceptTask = (value, origin) => {
    if (!value || !value.task_id) return;
    if (value.target !== HUMAN_TARGET || (task?.task_id && value.task_id !== task.task_id)) {
      fail('destination_guard', 'A task outside the configured human-only destination was observed.'); return;
    }
    const changed = task?.status !== value.status;
    task = value;
    if (changed) {
      report.jobUpdates.push({ atMs: elapsed(), origin, task_id: value.task_id, status: value.status,
        spoken: safe(value.spoken || '').slice(0, 1000), source: value.source || null,
        supporting_quote: safe(value.supporting_quote || '').slice(0, 800) });
      console.log(JSON.stringify({ phase: 'background_job', status: value.status, origin }));
    }
    if (terminal(value.status)) { jobTerminalAt ??= elapsed(); askOutcome(); }
  };
  const ack = mark => {
    if (mark.acknowledgedAtMs !== undefined) return;
    mark.acknowledgedAtMs = elapsed(); send({ type: 'mark', name: mark.name });
    if (ending || mark.playbackCancelled) return;
    if (turn === -1 && mark.sequence === 1) { feed(0); return; }
    if (!inputComplete) return;
    if (turn === 0 && preparedDraft && preparationAssistantAt !== null && mark.receivedAtMs >= preparationAssistantAt - 20) {
      confirmationMark = mark; report.timingMs.fullConfirmationPlaybackAcknowledged = elapsed();
      report.questions[0].playbackCompletedAtMs = elapsed(); later(() => feed(1), 450);
    } else if (turn === 1 && taskQueuedAt !== null && queuedAssistantAt !== null && mark.receivedAtMs >= queuedAssistantAt - 20) {
      report.questions[1].playbackCompletedAtMs = elapsed(); later(() => feed(2), 450);
    } else if (turn === 2 && washroomToolAt !== null && washroomAssistantAt !== null && mark.receivedAtMs >= washroomAssistantAt - 20) {
      report.questions[2].playbackCompletedAtMs = elapsed(); askOutcome();
    } else if (turn === 3 && taskStatusToolAt !== null && outcomeAssistantAt !== null && mark.receivedAtMs >= outcomeAssistantAt - 20) {
      report.questions[3].playbackCompletedAtMs = elapsed(); later(() => stop('signed_human_outcome_spoken'), 350);
    }
  };
  ws.on('open', () => {
    report.timingMs.socketOpened = elapsed(); send({ type: 'start_call' });
    inputInterval = setInterval(() => {
      if (ending || ws.readyState !== WebSocket.OPEN) return;
      const frame = Buffer.alloc(640);
      if (turn >= 0 && !inputComplete) {
        pcms[turn].copy(frame, 0, inputOffset, inputOffset + 640); inputOffset += 640;
        if (inputOffset >= pcms[turn].length) { inputComplete = true; report.questions[turn].inputCompleteAtMs = elapsed(); }
      }
      ws.send(frame);
    }, 20);
    pollInterval = setInterval(async () => {
      if (!task || ending || pollBusy) return;
      pollBusy = true;
      try { acceptTask(await request('/api/task'), 'authenticated_http'); }
      catch (error) { report.lastPollError = safe(error.message); }
      finally { pollBusy = false; }
    }, 2000);
  });
  ws.on('message', (raw, binary) => {
    if (binary) { fail('unexpected_binary_audio', 'Unexpected binary agent output.'); return; }
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { fail('invalid_frame', 'Invalid bridge JSON.'); return; }
    const at = elapsed();
    if (frame.type === 'audio') {
      if ((frame.sample_rate && frame.sample_rate !== 24000) || (frame.format && frame.format !== 'pcm16')) { fail('audio_format', 'Unexpected agent audio format.'); return; }
      const audio = Buffer.from(frame.data || '', 'base64'); audioChunks.push(audio);
      report.timingMs.firstAgentAudio ??= at;
      if (playhead <= at) playhead = at + 180;
      playhead += audio.length / 48;
    } else if (frame.type === 'mark') {
      const mark = { sequence: ++markSequence, name: frame.name, receivedAtMs: at, playbackEndsAtMs: Math.round(playhead) };
      report.marks.push(mark); later(() => ack(mark), Math.ceil(playhead - at));
    } else if (frame.type === 'clear_audio') {
      playhead = 0;
      for (const mark of report.marks) if (mark.acknowledgedAtMs === undefined) { mark.playbackCancelled = true; ack(mark); }
    } else if (frame.type === 'call_started') report.timingMs.voiceCallStarted = at;
    else if (frame.type === 'conversation_message') {
      const role = frame.role || frame.message?.role;
      const text = frame.content || frame.text || frame.message?.content || frame.message?.text;
      if (typeof text !== 'string') return;
      const entry = { atMs: at, role, content: safe(text).slice(0, 1600) };
      report.conversation.push(entry);
      if (['user', 'caller'].includes(role) && turn >= 0) report.questions[turn].transcribedInput = entry.content;
      if (role === 'assistant' && turn >= 0) {
        if (turn === 0 && preparedDraft && /call|phone/i.test(text) && /human|builder|friend/i.test(text) && /coffee/i.test(text) && /shall|should|want me|would you|okay|go ahead|may i|can i|confirm|make (?:the|that) call/i.test(text)) preparationAssistantAt = at;
        if (turn === 1 && taskQueuedAt !== null && at >= taskQueuedAt) queuedAssistantAt = at;
        if (turn === 2 && washroomToolAt !== null && at >= washroomToolAt) washroomAssistantAt = at;
        if (turn === 3 && taskStatusToolAt !== null && at >= taskStatusToolAt) outcomeAssistantAt = at;
        report.questions[turn].answerText = entry.content;
      }
    } else if (frame.type === 'job_update') acceptTask(frame, 'websocket');
    else if (frame.type === 'tool_activity') {
      const result = frame.result || {};
      report.tools.push({ atMs: at, tool: frame.tool, state: frame.state, spoken: safe(frame.spoken || '').slice(0, 1200),
        ...(frame.result ? { result: JSON.parse(safe(JSON.stringify(result))) } : {}) });
      if (frame.tool === 'location' || frame.tool === 'phone_result') return;
      const allowed = ['prepare_assistance_call', 'start_assistance_call', 'get_task_status', 'find_local_amenities', 'get_location'];
      if (!allowed.includes(frame.tool)) { fail('tool_allowlist', `Unexpected tool ${frame.tool}; the human-only test forbids nearby-business lookups and business calls.`); return; }
      if (frame.state === 'working') {
        const count = (toolCounts.get(frame.tool) || 0) + 1; toolCounts.set(frame.tool, count);
        if (['prepare_assistance_call', 'start_assistance_call', 'find_local_amenities'].includes(frame.tool) && count > 1) { fail('single_action_budget', `Repeated ${frame.tool} is outside this test's one-call budget.`); return; }
        if (frame.tool === 'start_assistance_call' && (!preparedDraft || !confirmationMark || turn < 1 || !report.questions[1].startedAtMs)) { fail('premature_call', 'The phone start occurred before the fully played confirmation and explicit synthetic yes.'); return; }
        if (frame.tool === 'find_local_amenities') report.timingMs.washroomLookupStarted = at;
      }
      if (frame.state === 'error' || result.ok === false) { fail('tool_failure', frame.spoken || result.spoken || 'A tool failed.'); return; }
      if (frame.state !== 'done') return;
      if (frame.tool === 'prepare_assistance_call') {
        if (result.status !== 'prepared' || result.target !== HUMAN_TARGET || !result.draft_id || result.budget_cad !== null || result.pickup_name !== null || !/coffee/i.test(result.request || '') || !/demo/i.test(result.request || '')) {
          fail('draft_guard', 'The prepared draft was not the exact human-help coffee-demo request. No confirmation will be sent.'); return;
        }
        preparedDraft = result; report.timingMs.humanDraftPrepared = at;
      } else if (frame.tool === 'start_assistance_call') {
        if (!result.task_id || result.target !== HUMAN_TARGET || !['queued', 'calling'].includes(result.status)) { fail('start_guard', 'The started task did not match the configured human-only target.'); return; }
        taskQueuedAt = at; report.timingMs.phoneTaskQueued = at; acceptTask(result, 'start_tool');
        later(() => { if (!jobTerminalAt) fail('job_deadline', 'No verified final phone outcome arrived within the ninety-second job window. A queued or calling task is not success.'); }, JOB_WAIT_MS);
      } else if (frame.tool === 'find_local_amenities') {
        if (result.kind !== 'washroom' || result.ok !== true) { fail('washroom_guard', 'The concurrent read-only tool was not a successful washroom lookup.'); return; }
        washroomToolAt = at; report.questions[2].toolCompletedAtMs = at;
      } else if (frame.tool === 'get_task_status') {
        if (!task || result.task_id !== task.task_id || !answered(result)) { fail('status_guard', 'The final status tool did not return the same transcript-grounded human task.'); return; }
        taskStatusToolAt = at; acceptTask(result, 'status_tool');
      }
    } else if (frame.type === 'error' || (frame.type === 'app_status' && frame.error)) fail('bridge_error', frame.message || frame.error || 'Voice bridge error.');
    else if (frame.type === 'snapshot_request') fail('unexpected_camera', 'No camera tool is authorized in this phone-only test.');
    else if (frame.type === 'call_ended') stop('voice_engine_ended');
  });
  ws.on('error', () => fail('socket_error', 'WebSocket bridge error.'));
  ws.on('close', code => { closed = true; report.closeCode = code; if (!ending) report.stopReason = 'socket_closed'; resolveDone(); });
  later(() => stop('session_deadline'), SESSION_WAIT_MS);
  await done;
  clearInterval(inputInterval); clearInterval(pollInterval);
  for (const timer of timers) clearTimeout(timer);
  if (!closed) ws.close(1000);
  report.elapsedMs = elapsed();
  const finalTask = await request('/api/task').catch(() => task);
  report.finalTask = finalTask ? JSON.parse(safe(JSON.stringify(finalTask))) : null;
  const matchingSignedReports = [];
  for (const file of await readdir(reportDirectory).catch(() => [])) {
    if (filesBefore.has(file) || !/^[A-Za-z0-9_-]+\.json$/.test(file)) continue;
    try {
      const saved = JSON.parse(await readFile(join(reportDirectory, file), 'utf8'));
      const receiptTime = Date.parse(saved.receivedAt);
      if (!saved.signatureVerified || saved.report?.agentId !== cfg.ALEBEX_CALLER_AGENT_ID || !Number.isFinite(receiptTime) || receiptTime < startedAt) continue;
      const callerText = Array.isArray(saved.report.messages) ? saved.report.messages.filter(message => message.role === 'caller').map(message => message.text).join('\n') : String(saved.report.transcript || '').split('\n').filter(line => /^You:|^Caller:/i.test(line)).map(line => line.replace(/^[^:]+:\s*/, '')).join('\n');
      if (!finalTask?.supporting_quote || !normalize(callerText).includes(normalize(finalTask.supporting_quote))) continue;
      matchingSignedReports.push({ reportId: saved.report.id, signatureVerified: true, callerQuoteVerified: true,
        endedReason: saved.report.endedReason || null, durationSeconds: saved.report.durationSeconds || null });
    } catch { /* Do not publish partial/private raw reports. */ }
  }
  report.signedReceiptEvidence = matchingSignedReports;
  const pcm = Buffer.concat(audioChunks);
  await mkdir(dirname(wavPath), { recursive: true });
  if (pcm.length) await writeFile(wavPath, wave(pcm), { mode: 0o600 });
  report.agentAudio = { path: pcm.length ? wavPath : null, sampleRate: 24000, channels: 1, audioBytes: pcm.length,
    audioSeconds: Number((pcm.length / 48000).toFixed(3)), note: 'Web assistant output only, concatenated without inter-turn silence; playback was simulated.' };
  const confirmation = report.questions[1];
  report.checks = {
    humanOnlyPrepared: preparedDraft?.target === HUMAN_TARGET,
    exactDraftBeforeConfirmation: Boolean(preparedDraft && confirmationMark),
    fullConfirmationPlaybackBeforeYes: Boolean(confirmationMark && !confirmationMark.playbackCancelled && confirmation.startedAtMs > confirmationMark.acknowledgedAtMs),
    explicitYesTranscribed: /\byes\b/i.test(confirmation.transcribedInput || '') && /go ahead/i.test(confirmation.transcribedInput || ''),
    marksNotAcknowledgedEarly: report.marks.every(mark => mark.playbackCancelled || mark.acknowledgedAtMs >= mark.playbackEndsAtMs),
    onePhoneStart: toolCounts.get('start_assistance_call') === 1,
    oneConcurrentWashroomLookup: toolCounts.get('find_local_amenities') === 1 && washroomToolAt !== null && report.timingMs.washroomLookupStarted > taskQueuedAt,
    washroomAnswerSpoken: Boolean(report.questions[2].answerText && report.questions[2].playbackCompletedAtMs),
    finalHumanAnswerVerified: answered(finalTask),
    signedReportAndCallerQuoteVerified: matchingSignedReports.length > 0,
    sameTaskStatusToolVerified: taskStatusToolAt !== null,
    finalOutcomeSpoken: Boolean(report.questions[3].answerText && report.questions[3].playbackCompletedAtMs),
    completedWithinJobWait: jobTerminalAt !== null && taskQueuedAt !== null && jobTerminalAt - taskQueuedAt <= JOB_WAIT_MS,
  };
  report.passed = report.errors.length === 0 && Object.values(report.checks).every(Boolean);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ reportPath, passed: report.passed, elapsedMs: report.elapsedMs, stopReason: report.stopReason,
    checks: report.checks, errors: report.errors, finalTask: report.finalTask, signedReceiptEvidence: report.signedReceiptEvidence,
    caveat: report.caveat }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => { console.error(JSON.stringify({ status: 'failed', error: String(error.message).replace(/(?:wt_|sk-or-v1-|whsec_)[A-Za-z0-9_-]+/g, '[redacted]') })); process.exitCode = 1; });
