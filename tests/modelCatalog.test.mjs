import { test } from 'node:test';
import assert from 'node:assert/strict';

const { MODEL_CATALOG, recommendedFor, defaultSuggestionFor, fimTemplateFor, looksLikeCoderModel } =
  await import('../out/llm/modelCatalog.js');

test('module imports without vscode', () => {
  assert.ok(Array.isArray(MODEL_CATALOG));
});

test('recommendedFor returns role-matching entries', () => {
  const completion = recommendedFor('completion');
  assert.ok(completion.length > 0);
  assert.ok(completion.every((e) => e.roles.includes('completion')));
  assert.ok(recommendedFor('embedding').some((e) => e.id === 'nomic-embed-text'));
});

test('defaultSuggestionFor returns the first pick per role', () => {
  assert.equal(defaultSuggestionFor('completion'), 'qwen2.5-coder:1.5b-base');
  assert.ok(defaultSuggestionFor('agent'));
});

test('fimTemplateFor: catalog hit', () => {
  assert.equal(fimTemplateFor('qwen2.5-coder:1.5b-base'), 'qwen');
  assert.equal(fimTemplateFor('codegemma:2b'), 'codegemma');
});

test('fimTemplateFor: name-pattern fallback for unlisted tags', () => {
  assert.equal(fimTemplateFor('qwen2.5-coder:14b-base'), 'qwen');
  assert.equal(fimTemplateFor('deepseek-coder:6.7b'), 'qwen');
  assert.equal(fimTemplateFor('gemma4:e4b'), 'none');
  assert.equal(fimTemplateFor(''), 'none');
});

test('looksLikeCoderModel', () => {
  assert.equal(looksLikeCoderModel('qwen2.5-coder:1.5b-base'), true);
  assert.equal(looksLikeCoderModel('devstral:24b'), true);
  assert.equal(looksLikeCoderModel('gemma4:e4b'), false);
});
