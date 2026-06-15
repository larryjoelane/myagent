// Pure helper for the auto-context "memory match threshold" setting.
// Kept Electron-free so it's unit-testable and reusable: main.js resolves
// the user's configured value through this, and the settings drawer slider
// writes the raw value that this clamps on read.

// Default minimum confidence for an auto-injected memory. Matches the
// interactive @memory search default. With MiniLM on short Q+A turns,
// strongly-relevant hits score ~0.7-0.9 and unrelated noise sits ~0.1-0.2,
// so 0.35 cleanly separates signal from noise.
const DEFAULT_MIN_CONFIDENCE = 0.35;

// Clamp a raw setting value to a valid threshold in [0, 1]. Returns the
// default when the value is unset, non-numeric, or out of range. Lower =
// recall more loosely (more context, more noise); higher = only near-
// identical past chats.
function resolveMinConfidence(raw, fallback = DEFAULT_MIN_CONFIDENCE) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

module.exports = { resolveMinConfidence, DEFAULT_MIN_CONFIDENCE };
