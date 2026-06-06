// peg-demo.js — a tiny, dependency-free PEG parser demo with ZERO regex.
//
// Run it with:   node peg-demo.js
//
// Earlier this used regex at the leaves, which hid the point. This version
// builds EVERYTHING from character-level primitives — no RegExp anywhere — so
// you can see what a "real" PEG engine actually is: a handful of tiny
// recognizers that compose. The structure (sequence / ordered choice /
// optional / repetition) lives in named rules, not in one mega-pattern.
//
// Each parser is a function:  (input, pos) -> { ok, pos, value } | { ok:false }
// `ok` means it matched; `pos` is where to continue; `value` is what it produced.

// --- primitives (the absolute leaves — no regex) ---------------------------

// match one specific character
const ch = (c) => (input, pos) =>
  input[pos] === c ? { ok: true, pos: pos + 1, value: c } : { ok: false };

// match one character in an inclusive range, e.g. range('a','z')
const range = (lo, hi) => (input, pos) => {
  const c = input[pos];
  return c >= lo && c <= hi ? { ok: true, pos: pos + 1, value: c } : { ok: false };
};

// match one character from an explicit set, e.g. anyOf('._-/')
const anyOf = (set) => (input, pos) => {
  const c = input[pos];
  return c !== undefined && set.includes(c) ? { ok: true, pos: pos + 1, value: c } : { ok: false };
};

// match any single character (PEG's `.`)
const anyChar = (input, pos) =>
  pos < input.length ? { ok: true, pos: pos + 1, value: input[pos] } : { ok: false };

// match an exact string, built from `ch` (still no regex)
const lit = (s) => (input, pos) => {
  let cur = pos;
  for (const c of s) {
    const r = ch(c)(input, cur);
    if (!r.ok) return { ok: false };
    cur = r.pos;
  }
  return { ok: true, pos: cur, value: s };
};

// --- combinators (the structure — sequence, choice, repetition, lookahead) -

// ordered choice: try each in order, first success wins (PEG's `/`)
const choice = (...ps) => (input, pos) => {
  for (const p of ps) {
    const r = p(input, pos);
    if (r.ok) return r;
  }
  return { ok: false };
};

// sequence: all must match, in order (PEG's `e1 e2`)
const seq = (...ps) => (input, pos) => {
  const values = [];
  let cur = pos;
  for (const p of ps) {
    const r = p(input, cur);
    if (!r.ok) return { ok: false };
    values.push(r.value);
    cur = r.pos;
  }
  return { ok: true, pos: cur, value: values };
};

// zero or more (PEG's `*`) — collects matched values into a joined string
const many = (p) => (input, pos) => {
  let cur = pos; const out = [];
  for (;;) {
    const r = p(input, cur);
    if (!r.ok) break;
    out.push(r.value); cur = r.pos;
  }
  return { ok: true, pos: cur, value: out.join('') };
};

// one or more (PEG's `+`)
const many1 = (p) => map(seq(p, many(p)), ([first, rest]) => first + rest);

// optional (PEG's `?`) — succeeds either way; value is '' when absent
const opt = (p) => (input, pos) => {
  const r = p(input, pos);
  return r.ok ? r : { ok: true, pos, value: '' };
};

// negative lookahead (PEG's `!e`) — succeeds if `p` does NOT match; consumes nothing
const not = (p) => (input, pos) =>
  p(input, pos).ok ? { ok: false } : { ok: true, pos, value: null };

// attach an action: transform a parser's value on success
function map(p, fn) {
  return (input, pos) => {
    const r = p(input, pos);
    return r.ok ? { ok: true, pos: r.pos, value: fn(r.value) } : r;
  };
}

// --- reusable leaf rules, composed from primitives (still no regex) ---------

const letter = choice(range('a', 'z'), range('A', 'Z'));
const digit = range('0', '9');
const space = ch(' ');
const ws = many(space);                       // zero+ spaces
const word = many1(letter);                   // one+ letters
// a path-ish token: letters/digits and path punctuation
const pathChar = choice(letter, digit, anyOf('._-/'));
const pathToken = many1(pathChar);
// "everything to end of input" — `(. )+` via one-or-more anyChar
const rest = many1(anyChar);

// --- the grammar (one rule per command shape) ------------------------------

// @provider:model   ->   { kind:'tag', provider, model }
const tag = map(
  seq(ch('@'), word, ch(':'), many1(choice(letter, digit, anyOf('._-/')))),
  ([, provider, , model]) => ({ kind: 'tag', provider, model }),
);

// /cmd rest...      ->   { kind:'slash', cmd, args }
const cmdName = many1(choice(letter, digit, anyOf('-_')));
const slash = map(
  seq(ch('/'), cmdName, ws, opt(rest)),
  ([, cmd, , args]) => ({ kind: 'slash', cmd: cmd.toLowerCase(), args: (args || '').trim() }),
);

// create|make <path> with|containing <content>   ->   { kind:'write', file, content }
const write = map(
  seq(
    choice(lit('create '), lit('make ')),
    pathToken,                                  // must be a path-ish token
    ws,
    choice(lit('with '), lit('containing ')),
    rest,
  ),
  ([, file, , , content]) => ({ kind: 'write', file, content: content.trim() }),
);

// top rule: ordered choice over all command shapes
const command = choice(tag, slash, write);

// Parse a whole line. Returns the structured command, or null (-> the input
// is not a recognized command, so we'd fall through to the LLM).
function parse(input) {
  const r = command(input, 0);
  return r.ok ? r.value : null;
}

// --- demo ------------------------------------------------------------------

if (require.main === module) {
  const samples = [
    '@openrouter:gpt-5-nano',
    '/memory-search javascript basics',
    'create notes.txt with hello world',
    'make src/util.js containing export const x = 1',
    'hey can you write me something nice', // no match -> null -> LLM
  ];
  console.log('Pure-PEG parse results — NO regex anywhere (null = falls through to the LLM):\n');
  for (const s of samples) {
    console.log(JSON.stringify(s));
    console.log('  ->', JSON.stringify(parse(s)));
    console.log();
  }
}

module.exports = {
  parse, command,
  // engine, exported so you can build your own grammars:
  ch, range, anyOf, anyChar, lit, choice, seq, many, many1, opt, not, map,
};
