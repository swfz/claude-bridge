import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shortModelName, modelTitleLine } from '../client/src/utils/modelLabel.js';

describe('shortModelName', () => {
  it('shortens current model ids', () => {
    assert.equal(shortModelName('claude-opus-5-5'), 'opus 5.5');
    assert.equal(shortModelName('claude-fable-5-2'), 'fable 5.2');
    assert.equal(shortModelName('claude-haiku-5-5'), 'haiku 5.5');
  });
  it('drops date suffixes and handles the old family-last form', () => {
    assert.equal(shortModelName('claude-sonnet-4-5-20250929'), 'sonnet 4.5');
    assert.equal(shortModelName('claude-3-5-haiku-20241022'), 'haiku 3.5');
    assert.equal(shortModelName('claude-opus-4-20250514'), 'opus 4');
  });
  it('marks the 1M context variant', () => {
    assert.equal(shortModelName('claude-opus-4-6[1m]'), 'opus 4.6 1M');
  });
  it('returns null for empty / synthetic', () => {
    assert.equal(shortModelName(''), null);
    assert.equal(shortModelName(undefined), null);
    assert.equal(shortModelName('<synthetic>'), null);
  });
  it('keeps unknown names as is', () => {
    assert.equal(shortModelName('gpt-x'), 'gpt-x');
  });
});

describe('modelTitleLine', () => {
  it('formats a tooltip line', () => {
    assert.equal(modelTitleLine('claude-opus-5-5'), '\nモデル: claude-opus-5-5');
    assert.equal(modelTitleLine(''), '');
    assert.equal(modelTitleLine('<synthetic>'), '');
  });
});
