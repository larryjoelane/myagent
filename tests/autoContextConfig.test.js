// autoContextConfig — the "Memory match threshold" slider setting.
// resolveMinConfidence() clamps the raw persisted value to [0,1] and
// backs the settings-drawer slider. One low + one high case.

const {
  resolveMinConfidence, DEFAULT_MIN_CONFIDENCE,
  resolveSpreadStrength, DEFAULT_SPREAD_STRENGTH,
} = require('../src/core/autoContextConfig');
const { eq } = require('./assert');

function run(t) {
  // --- Memory match threshold slider ---
  t.test('threshold slider low value is honored (loose recall)', () => {
    eq(resolveMinConfidence(0.1), 0.1, 'a low threshold passes through unchanged');
  });

  t.test('threshold slider high value is honored (strict recall)', () => {
    eq(resolveMinConfidence(0.9), 0.9, 'a high threshold passes through unchanged');
  });

  t.test('threshold out-of-range / non-numeric falls back to the default', () => {
    eq(resolveMinConfidence(undefined), DEFAULT_MIN_CONFIDENCE, 'unset → default');
    eq(resolveMinConfidence(5), DEFAULT_MIN_CONFIDENCE, '>1 → default');
  });

  // --- Synapse spread strength slider ---
  t.test('spread slider low value is honored (less associative recall)', () => {
    eq(resolveSpreadStrength(0.1), 0.1, 'a low spread passes through unchanged');
  });

  t.test('spread slider high value is honored (more associative recall)', () => {
    eq(resolveSpreadStrength(0.9), 0.9, 'a high spread passes through unchanged');
  });

  t.test('spread out-of-range / non-numeric falls back to the default', () => {
    eq(resolveSpreadStrength(undefined), DEFAULT_SPREAD_STRENGTH, 'unset → default');
    eq(resolveSpreadStrength(-1), DEFAULT_SPREAD_STRENGTH, '<0 → default');
  });
}

module.exports = { run };
