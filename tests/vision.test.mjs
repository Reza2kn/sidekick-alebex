import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImage } from '../lib/vision.mjs';

// Protocol fixture only; live image understanding is checked separately on a rendered menu.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6uEAAAAASUVORK5CYII=';
const model = { id: 'google/gemini-3.8-flash', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['response_format'] };
const input = () => ({ dataUrl: png, capturedAt: Date.now(), question: 'Read the menu.', source: 'test_fixture' });

test('stale images abstain before any provider request', async () => {
  const result = await analyzeImage({ ...input(), capturedAt: Date.now() - 120_000 }, {
    apiKey: 'fixture', fetch: () => { throw new Error('A stale image must not leave the app.'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'fresh_image_required');
  assert.deepEqual(result.observations, []);
});

test('malformed structured provider content is never spoken as raw JSON', async () => {
  const fetch = async url => url.endsWith('/models')
    ? { ok: true, json: async () => ({ data: [model] }) }
    : { ok: true, json: async () => ({ choices: [{ message: { content: '{"spoken":"The latte is' } }] }) };
  const result = await analyzeImage(input(), { apiKey: 'fixture', fetch });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'vision_response_unreadable');
  assert.doesNotMatch(result.spoken, /[{}]|"spoken"/);
});

test('known synthetic and uploaded images keep their provenance when the model omits it', async () => {
  const providerAnswer = {
    spoken: 'The decaf latte is four dollars and seventy-five cents.',
    observations: ['DECAF LATTE $4.75'], uncertainties: [],
  };
  const fetch = async url => url.endsWith('/models')
    ? { ok: true, json: async () => ({ data: [model] }) }
    : { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(providerAnswer) } }] }) };
  const synthetic = await analyzeImage({ ...input(), source: 'synthetic_fixture' }, { apiKey: 'fixture', fetch });
  assert.equal(synthetic.ok, true);
  assert.match(synthetic.spoken, /^On this demonstration image, /);
  assert.match(synthetic.spoken, /four dollars and seventy-five cents/);
  assert.equal(synthetic.source.image_source, 'synthetic_fixture');
  const uploaded = await analyzeImage({ ...input(), source: 'upload' }, { apiKey: 'fixture', fetch });
  assert.equal(uploaded.ok, true);
  assert.match(uploaded.spoken, /^In this uploaded image, /);
  assert.deepEqual(uploaded.observations, providerAnswer.observations);
});
