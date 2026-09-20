/**
 * The beam: which items a typed query lights up.
 *
 * D59's interaction. The input is not a search box that filters a list; it is a
 * light that falls on the map. This file answers only "what does the light
 * touch" — the renderer decides what lit and unlit look like, and its rule is
 * that unmatched items dim to 30% and never to zero, because a map that goes
 * black has told an already-anxious person that their project disappeared.
 *
 * Three ways in, because the person using this **may not be able to name what
 * they are looking for**:
 *
 *   1. Plain substring, over the plain-language label, the code name and the
 *      path. Someone who knows the word types the word.
 *   2. 초성. Typing `ㄱㅈ` finds 결제. This is how Koreans actually search, and it
 *      is the only path that works while the IME is mid-composition.
 *   3. The wrong keyboard. Typing `rufwp` with the IME still in English is not
 *      a mistake worth a error message — it is `결제`, and we can simply read it.
 *
 * Both maps are written out here rather than pulled from a package. They are
 * eighty lines of table that has not changed since 1982, and a dependency for
 * them would be a supply-chain surface for nothing.
 *
 * Cost: the index is built once per item set and every keystroke is a handful
 * of `indexOf` calls per item over precomputed strings — no allocation, no
 * regular expressions, no normalisation in the hot path.
 */

/** Everything the beam needs from an item. `GraphItem` satisfies this. */
export type BeamItem = {
  id: string;
  name: string;
  label: string | null;
  path: string | null;
};

export type BeamIndexEntry = {
  id: string;
  /** Everything searchable about the item, lowercased, joined. */
  text: string;
  /** The same text with every Hangul syllable reduced to its 초성. */
  cho: string;
};

export type BeamIndex = { entries: BeamIndexEntry[] };

export type BeamResult = {
  /** False when nothing is typed — which is not the same as "nothing matched". */
  active: boolean;
  matched: ReadonlySet<string>;
};

const NO_MATCHES: ReadonlySet<string> = new Set<string>();

export const IDLE_BEAM: BeamResult = { active: false, matched: NO_MATCHES };

/**
 * The same light, pointed by something other than typing.
 *
 * ## Why this is the beam and not a fourth mechanism
 *
 * `scene.ts` warns in writing against adding a second private idea of "near",
 * and the map already has three ways of saying "look here": `selection` (a
 * Focus and its one hop), `beam` (a set of items that match, everything else
 * at 30%), and `trail` (the walk an answer was found by, which takes the
 * lighting over while it is set). A change picked in the 변경 기록 band is a
 * *set of items that match* — the places living in the files that change
 * touched — which is what `beam` already means, word for word. So it becomes a
 * beam rather than a fourth path.
 *
 * The alternative was a `changed` highlight with its own dimming. It would
 * have needed its own answer to every question the beam has already answered:
 * what happens when a change is lit and somebody types, what 30% means when
 * two dimmings overlap, what the sentence under the canvas says. Each of those
 * answers is a chance for the map to dim for two reasons at once, which is the
 * failure D59 and `scene.ts`'s own warning both exist to prevent. One light
 * with two switches has one answer to all of them.
 *
 * The switches are exclusive, and the workspace is where that is enforced:
 * typing drops the picked change, and picking a change clears the box. Not a
 * precedence rule here, because a precedence rule would leave the losing one
 * *set and invisible* — a person would see their own search do nothing.
 *
 * An empty set returns the idle beam rather than an active one that matches
 * nothing. An active beam over an empty set dims the entire map and lights
 * nothing, which reads as the project having vanished — D59 exactly — when the
 * true answer is "this change did not touch anything on the map", and that is a
 * sentence, not a lighting state.
 */
export function beamOf(ids: ReadonlySet<string>): BeamResult {
  if (ids.size === 0) return IDLE_BEAM;
  return { active: true, matched: ids };
}

const CHO =
  "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG =
  "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
/** Index 0 is "no final consonant", which is why this one is an array. */
const JONG = [
  "",
  "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ",
  "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

const SYLLABLE_BASE = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const JUNG_COUNT = 21;
const JONG_COUNT = 28;

const CHO_SET = new Set(CHO.split(""));

/**
 * 두벌식. The only layout that matters here: a Korean user whose IME is in the
 * wrong mode is typing this one, on the keycaps printed on their machine.
 */
const QWERTY_TO_JAMO: Record<string, string | undefined> = {
  q: "ㅂ", w: "ㅈ", e: "ㄷ", r: "ㄱ", t: "ㅅ",
  y: "ㅛ", u: "ㅕ", i: "ㅑ", o: "ㅐ", p: "ㅔ",
  a: "ㅁ", s: "ㄴ", d: "ㅇ", f: "ㄹ", g: "ㅎ",
  h: "ㅗ", j: "ㅓ", k: "ㅏ", l: "ㅣ",
  z: "ㅋ", x: "ㅌ", c: "ㅊ", v: "ㅍ", b: "ㅠ", n: "ㅜ", m: "ㅡ",
  // Shifted keys. Only these five differ; every other capital is its lowercase.
  Q: "ㅃ", W: "ㅉ", E: "ㄸ", R: "ㄲ", T: "ㅆ", O: "ㅒ", P: "ㅖ",
};

/** Two vowels that fuse into one. `ㅗ` + `ㅏ` is `ㅘ`, not two letters. */
const JUNG_PAIRS: Record<string, string | undefined> = {
  "ㅗㅏ": "ㅘ", "ㅗㅐ": "ㅙ", "ㅗㅣ": "ㅚ",
  "ㅜㅓ": "ㅝ", "ㅜㅔ": "ㅞ", "ㅜㅣ": "ㅟ",
  "ㅡㅣ": "ㅢ",
};

/** Two final consonants that fuse into one, and how to take them apart again. */
const JONG_PAIRS: Record<string, string | undefined> = {
  "ㄱㅅ": "ㄳ", "ㄴㅈ": "ㄵ", "ㄴㅎ": "ㄶ",
  "ㄹㄱ": "ㄺ", "ㄹㅁ": "ㄻ", "ㄹㅂ": "ㄼ", "ㄹㅅ": "ㄽ",
  "ㄹㅌ": "ㄾ", "ㄹㅍ": "ㄿ", "ㄹㅎ": "ㅀ",
  "ㅂㅅ": "ㅄ",
};

const JONG_SPLIT: Record<string, [string, string] | undefined> = {};
for (const [pair, fused] of Object.entries(JONG_PAIRS)) {
  if (fused) JONG_SPLIT[fused] = [pair[0], pair[1]];
}

/**
 * The 초성 of every Hangul syllable in a string, everything else left alone.
 *
 * Latin passes through lowercased so one index serves both alphabets — a query
 * of `ㄱㅈ` and a query of `pay` are looked up the same way, against different
 * needles.
 */
export function choseongOf(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= SYLLABLE_BASE && code <= SYLLABLE_LAST) {
      out += CHO[Math.floor((code - SYLLABLE_BASE) / (JUNG_COUNT * JONG_COUNT))];
    } else {
      out += char.toLowerCase();
    }
  }
  return out;
}

/** True when every letter typed is a bare consonant — i.e. this is a 초성 query. */
export function isChoseongQuery(query: string): boolean {
  let seen = 0;
  for (const char of query) {
    if (char === " ") continue;
    if (!CHO_SET.has(char)) return false;
    seen++;
  }
  return seen > 0;
}

type Composing = { cho: number; jung: number; jong: number };

function emptyState(): Composing {
  return { cho: -1, jung: -1, jong: 0 };
}

function flush(state: Composing): string {
  if (state.cho >= 0 && state.jung >= 0) {
    return String.fromCharCode(
      SYLLABLE_BASE + state.cho * JUNG_COUNT * JONG_COUNT + state.jung * JONG_COUNT + state.jong,
    );
  }
  if (state.cho >= 0) return CHO[state.cho];
  if (state.jung >= 0) return JUNG[state.jung];
  return "";
}

/**
 * Latin typed on a QWERTY keyboard, read as the Hangul it would have produced.
 *
 * A real composition automaton rather than a character-for-character swap,
 * because `rufwp` is five keystrokes and two syllables: the `ㄹ` is 결's final
 * consonant, and the `ㅈ` that follows takes it over as 제's initial. A naive
 * mapping produces `ㄱㅕㄹㅈㅔ`, which matches nothing.
 *
 * A half-typed query leaves a bare jamo on the end — `rufw` reads as `결ㅈ` —
 * and that is correct and useful: `runBeam` takes the 초성 of the result, so the
 * beam lands on 결제 on the fourth keystroke rather than waiting for the fifth.
 */
export function toHangul(latin: string): string {
  let out = "";
  let state = emptyState();

  const commit = () => {
    out += flush(state);
    state = emptyState();
  };

  for (const char of latin) {
    const jamo = QWERTY_TO_JAMO[char] ?? QWERTY_TO_JAMO[char.toLowerCase()];
    if (!jamo) {
      // A digit, a dash, a space: not part of any syllable. Close what is open
      // and pass it through, so `rufwp-2` still reads as `결제-2`.
      commit();
      out += char;
      continue;
    }

    const jungIndex = JUNG.indexOf(jamo);
    if (jungIndex >= 0) {
      if (state.cho >= 0 && state.jung < 0) {
        state.jung = jungIndex;
      } else if (state.cho >= 0 && state.jung >= 0 && state.jong === 0) {
        const fused = JUNG_PAIRS[JUNG[state.jung] + jamo];
        if (fused) {
          state.jung = JUNG.indexOf(fused);
        } else {
          commit();
          out += jamo;
        }
      } else if (state.jong > 0) {
        // The final consonant belongs to the syllable starting now, not to the
        // one just finished. Split it off first if it was a fused pair.
        const held = JONG[state.jong];
        const split = JONG_SPLIT[held];
        const moving = split ? split[1] : held;
        state.jong = split ? JONG.indexOf(split[0]) : 0;
        commit();
        state.cho = CHO.indexOf(moving);
        state.jung = jungIndex;
      } else {
        commit();
        out += jamo;
      }
      continue;
    }

    // A consonant.
    const choIndex = CHO.indexOf(jamo);
    if (state.cho < 0) {
      state.cho = choIndex;
    } else if (state.jung < 0) {
      commit();
      state.cho = choIndex;
    } else if (state.jong === 0) {
      const asJong = JONG.indexOf(jamo);
      if (asJong > 0) {
        state.jong = asJong;
      } else {
        commit();
        state.cho = choIndex;
      }
    } else {
      const fused = JONG_PAIRS[JONG[state.jong] + jamo];
      if (fused) {
        state.jong = JONG.indexOf(fused);
      } else {
        commit();
        state.cho = choIndex;
      }
    }
  }

  out += flush(state);
  return out;
}

function basenameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Build the index once per item set.
 *
 * Everything the beam can match on is flattened into one lowercase string per
 * item, plus its 초성 form. Both are computed here so that a keystroke never
 * lowercases, never decomposes and never allocates — matching is `indexOf` and
 * nothing else. `\n` separates the fields so a match cannot straddle two of
 * them and report a word that does not exist.
 */
export function buildBeamIndex(items: readonly BeamItem[]): BeamIndex {
  const entries: BeamIndexEntry[] = [];
  for (const item of items) {
    const parts: string[] = [];
    if (item.label) parts.push(item.label);
    parts.push(item.name);
    if (item.path) {
      const base = basenameOf(item.path);
      if (base !== item.name) parts.push(base);
      if (item.path !== item.name) parts.push(item.path);
    }
    const text = parts.join("\n").toLowerCase();
    entries.push({ id: item.id, text, cho: choseongOf(text) });
  }
  return { entries };
}

/** Latin only, long enough to be a word: the shape of a wrong-IME query. */
const LATIN_WORD = /^[A-Za-z][A-Za-z ]+$/;

export function runBeam(index: BeamIndex, query: string): BeamResult {
  const trimmed = query.trim();
  if (trimmed === "") return IDLE_BEAM;

  const textNeedles: string[] = [trimmed.toLowerCase()];
  const choNeedles: string[] = [];

  if (isChoseongQuery(trimmed)) choNeedles.push(trimmed.replace(/ /g, ""));

  if (LATIN_WORD.test(trimmed)) {
    const hangul = toHangul(trimmed);
    if (hangul !== trimmed) {
      textNeedles.push(hangul.toLowerCase());
      const cho = choseongOf(hangul);
      // A single consonant would light every item beginning with it, which is
      // not a beam, it is a flood. Two is where the guess starts being useful.
      if (cho.length >= 2) choNeedles.push(cho);
    }
  }

  const matched = new Set<string>();
  for (const entry of index.entries) {
    let hit = false;
    for (const needle of textNeedles) {
      if (entry.text.includes(needle)) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const needle of choNeedles) {
        if (entry.cho.includes(needle)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) matched.add(entry.id);
  }

  return { active: true, matched };
}
