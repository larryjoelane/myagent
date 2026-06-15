// autoContextConfig — the "Memory match threshold" slider setting.
// resolveMinConfidence() clamps the raw persisted value to [0,1] and
// backs the settings-drawer slider. One low + one high case.

const { resolveMinConfidence, DEFAULT_MIN_CONFIDENCE } = require('../src/core/autoContextConfig');
const { eq } = require('./assert');

function run(t) {
  t.test('slider low value is honored (loose recall)', () => {
    eq(resolveMinConfidence(0.1), 0.1, 'a low threshold passes through unchanged');
  });

  t.test('slider high value is honored (strict recall)', () => {
    eq(resolveMinConfidence(0.9), 0.9, 'a high threshold passes through unchanged');
  });

  t.test('out-of-range / non-numeric falls back to the default', () => {
    eq(resolveMinConfidence(undefined), DEFAULT_MIN_CONFIDENCE, 'unset → default');
    eq(resolveMinConfidence(5), DEFAULT_MIN_CONFIDENCE, '>1 → default');
  });
}

module.exports = { run };
