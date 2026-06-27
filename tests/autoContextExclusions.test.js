// autoContextExclusions tests — the single source of truth for which
// worker kinds never receive auto-context preamble injection.

const { AUTO_CONTEXT_EXCLUDED_KINDS, isAutoContextExcluded } = require('../src/core/autoContextExclusions');
const { eq, ok } = require('./assert');

exports.run = (t) => {
  t.test('fly is excluded from auto-context', () => {
    ok(AUTO_CONTEXT_EXCLUDED_KINDS.includes('fly'), 'fly is in the excluded list');
    eq(isAutoContextExcluded('fly'), true, 'isAutoContextExcluded(fly) is true');
  });

  t.test('claude/ollama-cloud/openrouter/shell are not excluded', () => {
    eq(isAutoContextExcluded('claude'), false);
    eq(isAutoContextExcluded('ollama-cloud'), false);
    eq(isAutoContextExcluded('openrouter'), false);
    eq(isAutoContextExcluded('shell'), false);
  });

  t.test('unknown kind is not excluded by default', () => {
    eq(isAutoContextExcluded('some-future-kind'), false);
  });
};
