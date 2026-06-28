// Worker kinds that never receive auto-context (memory/file preamble
// injection), regardless of the contextProvider's result. Single source of
// truth so WorkerManager and any future caller agree on the list — kept as
// a plain array (not a Set) since callers want simple ===/includes checks
// and the list is short.
//
// `fly`: the chat text is an app/machine id consumed verbatim by
// FlyDeployDriver, not a prompt — a prepended preamble corrupts that value.
const AUTO_CONTEXT_EXCLUDED_KINDS = ['fly'];

function isAutoContextExcluded(kind) {
  return AUTO_CONTEXT_EXCLUDED_KINDS.includes(kind);
}

module.exports = { AUTO_CONTEXT_EXCLUDED_KINDS, isAutoContextExcluded };
