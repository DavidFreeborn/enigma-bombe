'use strict';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const ROTOR_SPECS = {
  I: { wiring: 'EKMFLGDQVZNTOWYHXUSPAIBRCJ', notch: 'Q' },
  II: { wiring: 'AJDKSIRUXBLHWTMCQGZNPYFVOE', notch: 'E' },
  III: { wiring: 'BDFHJLCPRTXVZNYEIWGAKMUSQO', notch: 'V' },
  IV: { wiring: 'ESOVPZJAYQUIRHXLNFTGKDCMWB', notch: 'J' },
  V: { wiring: 'VZBRGITYUPSDNHLXAWMJQOFECK', notch: 'Z' }
};

const REFLECTORS = {
  B: 'YRUHQSLDPXNGOKMIEBFZCWVJAT',
  C: 'FVPJIAOYEDRZXWGCTKUQSBNMHL'
};


const ROTOR_WIRINGS = Object.fromEntries(Object.entries(ROTOR_SPECS).map(([name, spec]) => [name, spec.wiring.split('').map((ch) => ch.charCodeAt(0) - 65)]));
const ROTOR_INVERSE_WIRINGS = {};
for (const [name, wiring] of Object.entries(ROTOR_WIRINGS)) {
  const inverse = Array(26).fill(0);
  wiring.forEach((out, input) => { inverse[out] = input; });
  ROTOR_INVERSE_WIRINGS[name] = inverse;
}
const ROTOR_NOTCHES = Object.fromEntries(Object.entries(ROTOR_SPECS).map(([name, spec]) => [name, new Set(spec.notch.split('').map((ch) => ch.charCodeAt(0) - 65))]));
const REFLECTOR_WIRINGS = Object.fromEntries(Object.entries(REFLECTORS).map(([name, wiring]) => [name, wiring.split('').map((ch) => ch.charCodeAt(0) - 65)]));

const DEFAULT_PLUGBOARD = 'AV BS CG DL FU HZ IN KM OW RX';
const DEFAULT_PLUGBOARD_PAIRS = DEFAULT_PLUGBOARD.split(' ');

let enigmaStepper = null;
let enigmaStepIndex = 0;
let enigmaStepText = '';
let enigmaStepOutput = '';
let enigmaAutoTimer = null;
let enigmaPlugboardPairs = DEFAULT_PLUGBOARD_PAIRS.slice();
let selectedPlugSocket = null;
let bombeStops = [];
let currentMenu = null;
let activeSearchToken = 0;
let cancelBombeSearch = false;
let bombeWorker = null;
const MIN_USEFUL_CRIB_LENGTH = 6;
const MAX_BOMBE_STOPS = 20000;
const MAX_STOPS_PER_CRIB_POSITION = 20000;
const MIN_BOMBE_CHECKS = 10000;

function $(id) {
  return document.getElementById(id);
}

function charToInt(ch) {
  return ch.toUpperCase().charCodeAt(0) - 65;
}

function intToChar(i) {
  return ALPHABET[((i % 26) + 26) % 26];
}

function sanitize(text) {
  return (text || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function mod26(n) {
  return ((n % 26) + 26) % 26;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[ch]));
}

function arrayEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function validateThreeLetters(value, label) {
  const cleaned = sanitize(value);
  if (cleaned.length !== 3) throw new Error(`${label} must contain exactly three letters A to Z.`);
  return cleaned;
}

function keepLettersOnly(id, maxLength = 3) {
  const el = $(id);
  const cleaned = sanitize(el.value).slice(0, maxLength);
  if (el.value !== cleaned) el.value = cleaned;
}

function validateRotorOrder(rotors) {
  if (!Array.isArray(rotors) || rotors.length !== 3) throw new Error('Exactly three rotors are required.');
  if (new Set(rotors).size !== 3) {
    throw new Error('Choose three different rotors. A wartime rotor set had one copy of each rotor, so the same rotor cannot be used twice.');
  }
  return rotors;
}

function permutations(items, length) {
  if (length === 0) return [[]];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest, length - 1)) out.push([items[i], ...tail]);
  }
  return out;
}

function setSelectOptions(select, values, selected) {
  select.innerHTML = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    if (value === selected) option.selected = true;
    select.appendChild(option);
  }
}

function sanitizePairs(input) {
  const rawPairs = Array.isArray(input) ? input : String(input || '').toUpperCase().trim().split(/\s+/).filter(Boolean);
  const pairs = [];
  const used = new Set();

  for (const rawPair of rawPairs) {
    const pair = sanitize(rawPair);
    if (!/^[A-Z]{2}$/.test(pair)) throw new Error(`Invalid plugboard pair: ${rawPair}.`);
    const a = pair[0];
    const b = pair[1];
    if (a === b) throw new Error(`Plugboard pair ${pair} connects a letter to itself.`);
    if (used.has(a) || used.has(b)) throw new Error(`Plugboard pair ${pair} reuses a letter.`);
    used.add(a);
    used.add(b);
    pairs.push(pair);
  }

  return pairs;
}

function parsePlugboardPairs(input) {
  const mapping = Array.from({ length: 26 }, (_, i) => i);
  const pairs = sanitizePairs(input);

  for (const pair of pairs) {
    const a = charToInt(pair[0]);
    const b = charToInt(pair[1]);
    mapping[a] = b;
    mapping[b] = a;
  }

  return { mapping, pairs };
}

class Rotor {
  constructor(name, ringSetting, position) {
    if (!ROTOR_SPECS[name]) throw new Error(`Unknown rotor: ${name}`);
    this.name = name;
    this.wiring = ROTOR_SPECS[name].wiring.split('').map(charToInt);
    this.inverseWiring = Array(26).fill(0);
    this.wiring.forEach((out, input) => {
      this.inverseWiring[out] = input;
    });
    this.notches = new Set(ROTOR_SPECS[name].notch.split('').map(charToInt));
    this.ring = charToInt(ringSetting);
    this.pos = charToInt(position);
  }

  atNotch() {
    return this.notches.has(this.pos);
  }

  step() {
    this.pos = mod26(this.pos + 1);
  }

  visiblePosition() {
    return intToChar(this.pos);
  }

  encodeForward(c) {
    const shifted = mod26(c + this.pos - this.ring);
    const wired = this.wiring[shifted];
    return mod26(wired - this.pos + this.ring);
  }

  encodeBackward(c) {
    const shifted = mod26(c + this.pos - this.ring);
    const wired = this.inverseWiring[shifted];
    return mod26(wired - this.pos + this.ring);
  }
}

class EnigmaMachine {
  constructor({ rotors, reflector, ringSettings, positions, plugboardPairs = [] }) {
    validateRotorOrder(rotors);
    const rings = validateThreeLetters(ringSettings, 'Ring settings');
    const pos = validateThreeLetters(positions, 'Window positions');
    if (!REFLECTORS[reflector]) throw new Error(`Unknown reflector: ${reflector}`);

    this.rotors = [
      new Rotor(rotors[0], rings[0], pos[0]),
      new Rotor(rotors[1], rings[1], pos[1]),
      new Rotor(rotors[2], rings[2], pos[2])
    ];
    this.reflectorName = reflector;
    this.reflector = REFLECTORS[reflector].split('').map(charToInt);
    const plugboard = parsePlugboardPairs(plugboardPairs);
    this.plugboard = plugboard.mapping;
    this.plugboardPairs = plugboard.pairs;
  }

  rotorPositions() {
    return this.rotors.map((rotor) => rotor.visiblePosition()).join('');
  }

  stepRotors() {
    const [left, middle, right] = this.rotors;
    const middleAtNotch = middle.atNotch();
    const rightAtNotch = right.atNotch();

    if (middleAtNotch) left.step();
    if (rightAtNotch || middleAtNotch) middle.step();
    right.step();
  }

  plug(c) {
    return this.plugboard[c];
  }

  coreEncodeInt(c) {
    for (let i = this.rotors.length - 1; i >= 0; i -= 1) c = this.rotors[i].encodeForward(c);
    c = this.reflector[c];
    for (let i = 0; i < this.rotors.length; i += 1) c = this.rotors[i].encodeBackward(c);
    return c;
  }

  corePermutation() {
    return Array.from({ length: 26 }, (_, i) => this.coreEncodeInt(i));
  }

  encodeChar(ch) {
    if (!/[A-Za-z]/.test(ch)) {
      return { output: '', trace: null, stepped: false };
    }

    const trace = {
      input: ch.toUpperCase(),
      before: this.rotorPositions(),
      stages: []
    };

    this.stepRotors();
    trace.afterStep = this.rotorPositions();

    let c = charToInt(ch);
    trace.stages.push({ name: 'Key pressed', kind: 'key', letter: intToChar(c) });

    c = this.plug(c);
    trace.stages.push({ name: 'Plugboard in', kind: 'plug', letter: intToChar(c) });

    for (let i = this.rotors.length - 1; i >= 0; i -= 1) {
      c = this.rotors[i].encodeForward(c);
      const side = i === 2 ? 'Right' : i === 1 ? 'Middle' : 'Left';
      trace.stages.push({ name: `${side} rotor ${this.rotors[i].name}`, kind: 'rotor', letter: intToChar(c) });
    }

    c = this.reflector[c];
    trace.stages.push({ name: `Reflector ${this.reflectorName}`, kind: 'reflector', letter: intToChar(c) });

    for (let i = 0; i < this.rotors.length; i += 1) {
      c = this.rotors[i].encodeBackward(c);
      const side = i === 0 ? 'Left' : i === 1 ? 'Middle' : 'Right';
      trace.stages.push({ name: `${side} rotor return`, kind: 'rotor', letter: intToChar(c) });
    }

    c = this.plug(c);
    trace.stages.push({ name: 'Plugboard out', kind: 'plug', letter: intToChar(c) });
    trace.stages.push({ name: 'Lamp lit', kind: 'lamp', letter: intToChar(c) });
    trace.output = intToChar(c);

    return { output: intToChar(c), trace, stepped: true };
  }

  encode(text) {
    let output = '';
    let lastTrace = null;
    for (const ch of sanitize(text)) {
      const encoded = this.encodeChar(ch);
      output += encoded.output;
      if (encoded.trace) lastTrace = encoded.trace;
    }
    return { output, lastTrace };
  }
}

function invertPermutation(perm) {
  const inv = Array(26).fill(0);
  perm.forEach((value, i) => {
    inv[value] = i;
  });
  return inv;
}

function countPlugboardPairs(mapping) {
  let count = 0;
  for (let i = 0; i < 26; i += 1) {
    if (mapping[i] !== -1 && i < mapping[i]) count += 1;
  }
  return count;
}

function countUnknowns(mapping) {
  return mapping.filter((value) => value === -1).length;
}

function assignStecker(mapping, x, y, maxPairs = 10, exactPairs = 10) {
  const next = mapping.slice();

  function setOne(a, b) {
    if (next[a] !== -1) return next[a] === b;
    next[a] = b;
    return true;
  }

  if (!setOne(x, y)) return null;
  if (!setOne(y, x)) return null;

  const pairCount = countPlugboardPairs(next);
  if (pairCount > maxPairs) return null;

  if (exactPairs !== null) {
    if (pairCount > exactPairs) return null;
    if (pairCount + Math.floor(countUnknowns(next) / 2) < exactPairs) return null;
  }

  return next;
}

function propagateMenu(mapping, constraints, maxPairs = 10, exactPairs = 10) {
  let current = mapping.slice();
  let changed = true;

  while (changed) {
    changed = false;
    for (const constraint of constraints) {
      const { plain, cipher, perm, inv } = constraint;

      if (current[plain] !== -1) {
        const required = perm[current[plain]];
        const next = assignStecker(current, cipher, required, maxPairs, exactPairs);
        if (next === null) return null;
        if (!arrayEquals(next, current)) {
          current = next;
          changed = true;
        }
      }

      if (current[cipher] !== -1) {
        const required = inv[current[cipher]];
        const next = assignStecker(current, plain, required, maxPairs, exactPairs);
        if (next === null) return null;
        if (!arrayEquals(next, current)) {
          current = next;
          changed = true;
        }
      }
    }
  }

  return current;
}

function formatPartialPlugboard(mapping) {
  const pairs = [];
  const fixed = [];
  const unknown = [];
  for (let i = 0; i < 26; i += 1) {
    const value = mapping[i];
    if (value === -1) unknown.push(intToChar(i));
    else if (value === i) fixed.push(intToChar(i));
    else if (i < value) pairs.push(intToChar(i) + intToChar(value));
  }
  return { pairs, fixed, unknown };
}

function chooseTestLetter(constraints) {
  const degree = Array(26).fill(0);
  const nodes = new Set();
  constraints.forEach(({ plain, cipher }) => {
    degree[plain] += 1;
    degree[cipher] += 1;
    nodes.add(plain);
    nodes.add(cipher);
  });
  let best = Array.from(nodes)[0];
  for (const node of nodes) {
    if (degree[node] > degree[best]) best = node;
  }
  return { testLetter: best, degree, nodes: Array.from(nodes) };
}

function corePermsForCrib(rotors, reflector, ringSettings, positions, offset, cribLength) {
  const machine = new EnigmaMachine({ rotors, reflector, ringSettings, positions, plugboardPairs: [] });
  for (let i = 0; i < offset; i += 1) machine.stepRotors();

  const perms = [];
  const positionLabels = [];
  for (let i = 0; i < cribLength; i += 1) {
    machine.stepRotors();
    positionLabels.push(machine.rotorPositions());
    perms.push(machine.corePermutation());
  }
  return { perms, positionLabels };
}

function buildMenu(ciphertext, crib, offset, rotors, reflector, ringSettings, positions) {
  const cleanCipher = sanitize(ciphertext);
  const cleanCrib = sanitize(crib);
  const numericOffset = Number.parseInt(offset, 10);

  if (!cleanCipher) throw new Error('Ciphertext must contain letters.');
  if (!cleanCrib) throw new Error('Crib must contain letters.');
  if (!Number.isInteger(numericOffset) || numericOffset < 0) throw new Error('Offset must be a non-negative integer.');
  if (numericOffset + cleanCrib.length > cleanCipher.length) throw new Error('The crib does not fit at this offset.');

  const cipherSlice = cleanCipher.slice(numericOffset, numericOffset + cleanCrib.length);
  const noSelfEncryptionFailures = [];
  for (let i = 0; i < cleanCrib.length; i += 1) {
    if (cleanCrib[i] === cipherSlice[i]) noSelfEncryptionFailures.push(i);
  }

  const core = corePermsForCrib(rotors, reflector, ringSettings, positions, numericOffset, cleanCrib.length);
  const constraints = [];
  for (let i = 0; i < cleanCrib.length; i += 1) {
    const plain = charToInt(cleanCrib[i]);
    const cipher = charToInt(cipherSlice[i]);
    const perm = core.perms[i];
    constraints.push({
      index: i,
      plain,
      cipher,
      plainLetter: cleanCrib[i],
      cipherLetter: cipherSlice[i],
      perm,
      inv: invertPermutation(perm),
      rotorPosition: core.positionLabels[i]
    });
  }

  return {
    ciphertext: cleanCipher,
    crib: cleanCrib,
    cipherSlice,
    offset: numericOffset,
    constraints,
    noSelfEncryptionFailures,
    rotors,
    reflector,
    ringSettings,
    positions
  };
}

function menuGraphStats(menu) {
  const vertices = new Set();
  const adjacency = new Map();
  for (const edge of menu.constraints) {
    vertices.add(edge.plainLetter);
    vertices.add(edge.cipherLetter);
    if (!adjacency.has(edge.plainLetter)) adjacency.set(edge.plainLetter, new Set());
    if (!adjacency.has(edge.cipherLetter)) adjacency.set(edge.cipherLetter, new Set());
    adjacency.get(edge.plainLetter).add(edge.cipherLetter);
    adjacency.get(edge.cipherLetter).add(edge.plainLetter);
  }
  let components = 0;
  const seen = new Set();
  for (const v of vertices) {
    if (seen.has(v)) continue;
    components += 1;
    const stack = [v];
    seen.add(v);
    while (stack.length) {
      const cur = stack.pop();
      for (const nxt of adjacency.get(cur) || []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          stack.push(nxt);
        }
      }
    }
  }
  const edges = menu.constraints.length;
  const vertexCount = vertices.size;
  const cycles = Math.max(0, edges - vertexCount + components);
  return { edges, vertexCount, components, cycles };
}

const NODE_COUNT = 26 * 26;

function nodeIndex(row, value) {
  return 26 * row + value;
}

class DSU {
  constructor(parent = null, rank = null) {
    this.parent = parent ? parent.slice() : new Int16Array(NODE_COUNT);
    this.rank = rank ? rank.slice() : new Int8Array(NODE_COUNT);
    if (!parent) {
      for (let i = 0; i < NODE_COUNT; i += 1) this.parent[i] = i;
    }
  }

  find(x) {
    let p = this.parent;
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  }

  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      const tmp = ra;
      ra = rb;
      rb = tmp;
    }
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra] += 1;
  }
}

function buildDiagonalBoardBase() {
  const dsu = new DSU();
  for (let a = 0; a < 26; a += 1) {
    for (let b = a + 1; b < 26; b += 1) {
      dsu.union(nodeIndex(a, b), nodeIndex(b, a));
    }
  }
  return { parent: dsu.parent, rank: dsu.rank };
}

const DIAGONAL_BASE = buildDiagonalBoardBase();

function componentMapping(dsu, root) {
  const mapping = Array(26).fill(-1);
  for (let n = 0; n < NODE_COUNT; n += 1) {
    if (dsu.find(n) === root) {
      const row = Math.floor(n / 26);
      const value = n % 26;
      if (mapping[row] === -1) mapping[row] = value;
      else if (mapping[row] !== value) return null;
    }
  }
  return mapping;
}

function testBombePosition(menu, maxPairs = 10, exactPairs = 10) {
  if (menu.noSelfEncryptionFailures.length > 0) return null;

  const { testLetter } = chooseTestLetter(menu.constraints);
  const dsu = new DSU(DIAGONAL_BASE.parent, DIAGONAL_BASE.rank);

  for (const constraint of menu.constraints) {
    for (let x = 0; x < 26; x += 1) {
      dsu.union(nodeIndex(constraint.plain, x), nodeIndex(constraint.cipher, constraint.perm[x]));
    }
  }

  const rowMasks = new Int32Array(NODE_COUNT);
  const badRoots = new Uint8Array(NODE_COUNT);
  for (let n = 0; n < NODE_COUNT; n += 1) {
    const row = Math.floor(n / 26);
    const root = dsu.find(n);
    const bit = 1 << row;
    const current = rowMasks[root];
    if (current & bit) badRoots[root] = 1;
    rowMasks[root] = current | bit;
  }

  const survivors = [];
  for (let value = 0; value < 26; value += 1) {
    const root = dsu.find(nodeIndex(testLetter, value));
    if (!badRoots[root]) {
      const mapping = componentMapping(dsu, root);
      if (mapping) survivors.push({ value, mapping });
    }
  }

  if (survivors.length === 0) {
    return { isStop: false, testLetter, survivors: [], rejected: true };
  }

  const chosen = survivors.slice().sort((a, b) => {
    const mappedA = a.mapping.filter((x) => x !== -1).length;
    const mappedB = b.mapping.filter((x) => x !== -1).length;
    return mappedB - mappedA;
  })[0];

  const formatted = formatPartialPlugboard(chosen.mapping);
  return {
    isStop: true,
    testLetter,
    survivors: survivors.map((item) => intToChar(item.value)),
    survivorMappings: survivors,
    mapping: chosen.mapping,
    pairs: formatted.pairs,
    fixed: formatted.fixed,
    unknown: formatted.unknown,
    menu
  };
}

function positionFromIndex(index) {
  const a = Math.floor(index / (26 * 26));
  const b = Math.floor((index % (26 * 26)) / 26);
  const c = index % 26;
  return intToChar(a) + intToChar(b) + intToChar(c);
}

function plugboardStringFromPairs(pairs) {
  return (pairs || []).join(' ');
}

function decodeWithStop(ciphertext, stop, pairs) {
  const machine = new EnigmaMachine({
    rotors: stop.rotors,
    reflector: stop.reflector,
    ringSettings: stop.ringSettings,
    positions: stop.positions,
    plugboardPairs: plugboardStringFromPairs(pairs || stop.pairs)
  });
  return machine.encode(sanitize(ciphertext)).output;
}

const COMMON_WORDS = [
  'THE', 'AND', 'THAT', 'HAVE', 'WITH', 'FROM', 'THIS', 'ATTACK', 'DAWN',
  'REPORT', 'WEATHER', 'MESSAGE', 'POSITION', 'ENEMY', 'SUPPLY', 'TROOPS'
];

function englishScore(text, extraWords = []) {
  const clean = sanitize(text);
  const words = COMMON_WORDS.concat(extraWords.map((word) => sanitize(word)).filter(Boolean));
  let score = 0;
  for (const word of words) {
    const matches = clean.match(new RegExp(word, 'g'));
    if (matches) score += matches.length * word.length;
  }
  const vowels = clean.split('').filter((ch) => 'AEIOU'.includes(ch)).length;
  const ratio = clean.length ? vowels / clean.length : 0;
  score -= Math.round(Math.abs(ratio - 0.38) * 20);
  return score;
}

function generatePairCompletions(unknownLetters, pairsNeeded, maxCompletions = 15000) {
  const available = unknownLetters.slice().sort();
  const completions = [];

  function rec(letters, needed, current) {
    if (completions.length >= maxCompletions) return;
    if (needed === 0) {
      completions.push(current.slice());
      return;
    }
    if (letters.length < 2 * needed) return;

    const first = letters[0];
    const rest = letters.slice(1);
    for (let i = 0; i < rest.length; i += 1) {
      const second = rest[i];
      const remaining = rest.slice(0, i).concat(rest.slice(i + 1));
      rec(remaining, needed - 1, current.concat(first + second));
    }
    if (rest.length >= 2 * needed) rec(rest, needed, current);
  }

  rec(available, pairsNeeded, []);
  return completions;
}

function completeAndDecode(ciphertext, stop, totalPairs = 10, maxCompletionsPerMapping = 15000) {
  const localResult = testBombePosition(stop.menu);
  const survivorMappings = localResult && localResult.survivorMappings && localResult.survivorMappings.length
    ? localResult.survivorMappings.map((item) => item.mapping)
    : [stop.mapping].filter(Boolean);

  const candidates = [];
  const seen = new Set();
  for (const mapping of survivorMappings) {
    const formatted = formatPartialPlugboard(mapping);
    const knownPairs = formatted.pairs || [];
    const pairsNeeded = totalPairs - knownPairs.length;
    if (pairsNeeded < 0) continue;
    const completions = generatePairCompletions(formatted.unknown || [], pairsNeeded, maxCompletionsPerMapping);
    for (const completion of completions) {
      const pairs = knownPairs.concat(completion).sort();
      const key = pairs.join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      const plaintext = decodeWithStop(ciphertext, stop, pairs);
      candidates.push({ pairs, plaintext, score: englishScore(plaintext, [stop.menu.crib, 'WEATHERREPORTATDAWN']) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 10);
}

function getEnigmaSettingsFromUI() {
  const rotors = [$('enigma-left-rotor').value, $('enigma-middle-rotor').value, $('enigma-right-rotor').value];
  validateRotorOrder(rotors);
  return {
    rotors,
    reflector: $('enigma-reflector').value,
    ringSettings: validateThreeLetters($('enigma-rings').value, 'Ring settings'),
    positions: validateThreeLetters($('enigma-positions').value, 'Window positions'),
    plugboardPairs: enigmaPlugboardPairs
  };
}

function getBombeBaseSettings() {
  const rotors = [$('bombe-left-rotor').value, $('bombe-middle-rotor').value, $('bombe-right-rotor').value];
  const mode = $('bombe-search-mode') ? $('bombe-search-mode').value : 'standard';
  if (mode === 'chosen' || mode === 'chosen-rings') validateRotorOrder(rotors);
  return {
    rotors,
    reflector: $('bombe-reflector').value,
    ringSettings: validateThreeLetters($('bombe-rings').value, 'Ring settings')
  };
}

function getBombeSearchConfig() {
  const mode = $('bombe-search-mode') ? $('bombe-search-mode').value : 'standard';
  const settings = getBombeBaseSettings();
  if (mode === 'chosen' || mode === 'chosen-rings') {
    return {
      mode,
      settings,
      scope: 'selected',
      allRings: mode === 'chosen-rings',
      rotorText: `chosen order ${settings.rotors.join('-')}`,
      reflectorText: `reflector ${settings.reflector}`,
      ringText: mode === 'chosen-rings' ? 'all ring settings AAA to ZZZ' : `ring setting ${settings.ringSettings}`,
      modeLabel: mode === 'chosen-rings' ? 'Chosen setup, all ring settings' : 'Chosen setup, fixed ring setting'
    };
  }
  return {
    mode,
    settings,
    scope: 'orders-both-reflectors',
    allRings: mode === 'exhaustive-rings',
    rotorText: 'all 60 rotor orders',
    reflectorText: 'reflectors B and C',
    ringText: mode === 'exhaustive-rings' ? 'all ring settings AAA to ZZZ' : `ring setting ${settings.ringSettings}`,
    modeLabel: mode === 'exhaustive-rings' ? 'Exhaustive ring search' : 'Standard search, fixed ring setting'
  };
}

function estimateTestCount(config, offsets) {
  const rotorCount = config.scope === 'selected' ? 1 : 60;
  const reflectorCount = config.scope === 'orders-both-reflectors' ? 2 : 1;
  const ringCount = config.allRings ? 26 * 26 * 26 : 1;
  const windowCount = 26 * 26 * 26;
  return rotorCount * reflectorCount * ringCount * windowCount * Math.max(1, offsets.length);
}

function formatInteger(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : 'unknown';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  if (seconds < 1) return 'under 1s';
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['min', 60],
    ['s', 1]
  ];
  let remaining = Math.round(seconds);
  const parts = [];
  for (const [name, size] of units) {
    if (remaining >= size || (name === 's' && !parts.length)) {
      const value = Math.floor(remaining / size);
      remaining -= value * size;
      if (value > 0 || name === 's') parts.push(`${value}${name === 's' ? 's' : ' ' + name + (value === 1 ? '' : 's')}`);
    }
    if (parts.length >= 2) break;
  }
  return parts.join(' ');
}

function progressMessage(checked, total, seconds, stops) {
  const elapsed = Number.parseFloat(seconds) || 0;
  const rate = checked > 0 && elapsed > 0 ? checked / elapsed : 0;
  const remaining = rate > 0 ? Math.max(0, total - checked) / rate : Infinity;
  return `Checked ${formatInteger(checked)} of ${formatInteger(total)} tests in ${formatDuration(elapsed)}. Speed: ${formatInteger(rate)} tests/s. ETA: ${formatDuration(remaining)}. Candidate stops stored: ${stops}.`;
}

function updateSearchSummary() {
  if (!$('search-summary') || !$('search-estimate')) return;
  try {
    keepLettersOnly('bombe-rings', 3);
    const config = getBombeSearchConfig();
    const ringWrapper = $('bombe-ring-wrapper');
    if (ringWrapper) ringWrapper.hidden = config.allRings;
    const chosenSetup = $('bombe-chosen-setup');
    if (chosenSetup) {
      const usesChosenSetup = config.mode === 'chosen' || config.mode === 'chosen-rings';
      chosenSetup.hidden = !usesChosenSetup;
      if (usesChosenSetup) chosenSetup.open = true;
    }
    const offsets = possibleOffsets($('bombe-ciphertext').value, $('bombe-crib').value);
    const total = offsets.length ? estimateTestCount(config, offsets) : 0;
    $('search-summary').innerHTML = [
      config.modeLabel,
      config.rotorText,
      config.reflectorText,
      config.ringText,
      'all start windows AAA to ZZZ',
      offsets.length ? `${offsets.length} crib placement${offsets.length === 1 ? '' : 's'}` : 'no possible crib placements yet'
    ].map((item) => `<span>${escapeHtml(item)}</span>`).join('');
    const ringWarning = config.allRings ? ' This searches all ring settings, so the ring-setting input is not used. It is 17,576 times larger than a fixed-ring search.' : '';
    $('search-estimate').textContent = total ? `Planned tests: ${formatInteger(total)}.${ringWarning}` : 'Enter ciphertext and a crib to estimate the search size.';
  } catch (error) {
    $('search-estimate').textContent = error.message;
  }
}

function randomLetters(n) {
  let out = '';
  for (let i = 0; i < n; i += 1) out += intToChar(Math.floor(Math.random() * 26));
  return out;
}

function randomPlugboardPairs(pairCount) {
  const letters = ALPHABET.split('').sort(() => Math.random() - 0.5);
  const pairs = [];
  for (let i = 0; i < pairCount * 2; i += 2) pairs.push(letters[i] + letters[i + 1]);
  return pairs;
}

function pairForLetter(letter) {
  return enigmaPlugboardPairs.find((pair) => pair.includes(letter)) || null;
}

function setPlugboardPairs(pairs) {
  enigmaPlugboardPairs = sanitizePairs(pairs);
  selectedPlugSocket = null;
  renderPlugboard();
  resetEnigmaStepper();
}

function removePlugboardPair(pair) {
  enigmaPlugboardPairs = enigmaPlugboardPairs.filter((p) => p !== pair);
  selectedPlugSocket = null;
  renderPlugboard();
  resetEnigmaStepper();
}

function addPlugboardPair(a, b) {
  if (a === b) return;
  if (pairForLetter(a) || pairForLetter(b)) return;
  if (enigmaPlugboardPairs.length >= 10) return;
  enigmaPlugboardPairs.push(a < b ? a + b : b + a);
  enigmaPlugboardPairs.sort();
  selectedPlugSocket = null;
  renderPlugboard();
  resetEnigmaStepper();
}

function plugboardCoordinates(letter) {
  const i = charToInt(letter);
  const row = i < 13 ? 0 : 1;
  const col = i % 13;
  return { x: 40 + col * 52, y: row === 0 ? 48 : 136 };
}

function renderPlugboard() {
  const width = 700;
  const height = 184;
  const wires = enigmaPlugboardPairs.map((pair) => {
    const a = plugboardCoordinates(pair[0]);
    const b = plugboardCoordinates(pair[1]);
    const midY = Math.min(a.y, b.y) - 34;
    const path = `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
    return `<path class="plug-wire-shadow" d="${path}"></path><path class="plug-wire" d="${path}"></path>`;
  }).join('');

  const sockets = ALPHABET.split('').map((letter) => {
    const p = plugboardCoordinates(letter);
    const used = pairForLetter(letter);
    const classes = ['socket'];
    if (used) classes.push('used');
    else classes.push('unused');
    if (selectedPlugSocket === letter) classes.push('selected');
    return `
      <g class="${classes.join(' ')}" data-letter="${letter}" role="button" tabindex="0" aria-label="Plugboard socket ${letter}">
        <circle cx="${p.x}" cy="${p.y}" r="18"></circle>
        <text x="${p.x}" y="${p.y + 1}">${letter}</text>
      </g>`;
  }).join('');

  $('plugboard-physical').innerHTML = `
    <svg class="plugboard-svg" viewBox="0 0 ${width} ${height}">
      ${wires}
      ${sockets}
    </svg>`;

  $('plugboard-count').textContent = `${enigmaPlugboardPairs.length} wire${enigmaPlugboardPairs.length === 1 ? '' : 's'} connected`;
  $('plugboard-pairs-list').innerHTML = enigmaPlugboardPairs.length
    ? enigmaPlugboardPairs.map((pair) => `<span class="wire-chip">${pair[0]} ↔ ${pair[1]}</span>`).join('')
    : '<span class="hint">No plugboard wires.</span>';
}

function handlePlugboardClick(letter) {
  const existing = pairForLetter(letter);
  if (existing) {
    removePlugboardPair(existing);
    return;
  }
  if (!selectedPlugSocket) {
    selectedPlugSocket = letter;
    renderPlugboard();
    return;
  }
  addPlugboardPair(selectedPlugSocket, letter);
}

function showError(message, targetId = 'enigma-state-pill') {
  const target = $(targetId);
  target.textContent = message;
  target.style.background = '#f8e9e5';
  target.style.color = '#9b3f3f';
  target.style.borderColor = '#d7a29b';
}

function showReady(message, targetId = 'enigma-state-pill') {
  const target = $(targetId);
  target.textContent = message;
  target.style.background = '';
  target.style.color = '';
  target.style.borderColor = '';
}

function updatePreparedText() {
  const prepared = sanitize($('enigma-input').value);
  $('enigma-prepared').value = prepared;
  return prepared;
}

function setEnigmaExample() {
  $('enigma-left-rotor').value = 'I';
  $('enigma-middle-rotor').value = 'II';
  $('enigma-right-rotor').value = 'III';
  $('enigma-reflector').value = 'B';
  $('enigma-rings').value = 'AAA';
  $('enigma-positions').value = 'MCK';
  $('enigma-input').value = 'WEATHER REPORT AT DAWN';
  setPlugboardPairs(DEFAULT_PLUGBOARD_PAIRS);
}

function setRandomSettings() {
  const rotorNames = Object.keys(ROTOR_SPECS);
  const order = permutations(rotorNames, 3)[Math.floor(Math.random() * 60)];
  $('enigma-left-rotor').value = order[0];
  $('enigma-middle-rotor').value = order[1];
  $('enigma-right-rotor').value = order[2];
  $('enigma-reflector').value = Math.random() < 0.5 ? 'B' : 'C';
  $('enigma-rings').value = randomLetters(3);
  $('enigma-positions').value = randomLetters(3);
  setPlugboardPairs(randomPlugboardPairs(10));
}

function runEnigma() {
  try {
    const prepared = updatePreparedText();
    const machine = new EnigmaMachine(getEnigmaSettingsFromUI());
    const result = machine.encode(prepared);
    $('enigma-output').value = result.output;
    if (result.lastTrace) {
      renderEnigmaTrace(result.lastTrace);
      showReady('Done');
    } else {
      renderEnigmaTrace(null);
      showReady('No letters encoded');
    }
  } catch (error) {
    showError(error.message);
  }
}

function resetEnigmaStepper() {
  try {
    if (enigmaAutoTimer !== null) {
      clearInterval(enigmaAutoTimer);
      enigmaAutoTimer = null;
      $('enigma-auto').textContent = 'Animate message';
    }
    enigmaStepText = updatePreparedText();
    enigmaStepper = new EnigmaMachine(getEnigmaSettingsFromUI());
    enigmaStepIndex = 0;
    enigmaStepOutput = '';
    $('enigma-output').value = '';
    renderEnigmaTrace(null);
    showReady('Ready');
  } catch (error) {
    showError(error.message);
  }
}

function stepEnigma() {
  try {
    if (!enigmaStepper) resetEnigmaStepper();
    if (enigmaStepIndex >= enigmaStepText.length) {
      showReady('End of prepared letters');
      return;
    }

    const ch = enigmaStepText[enigmaStepIndex];
    const encoded = enigmaStepper.encodeChar(ch);
    enigmaStepOutput += encoded.output;
    enigmaStepIndex += 1;
    $('enigma-output').value = enigmaStepOutput;
    if (encoded.trace) {
      renderEnigmaTrace(encoded.trace);
      showReady(`Letter ${enigmaStepIndex} of ${enigmaStepText.length}, windows ${encoded.trace.afterStep}`);
    } else {
      showReady(`Letter ${enigmaStepIndex} of ${enigmaStepText.length}`);
    }
  } catch (error) {
    showError(error.message);
  }
}

function toggleAutoStep() {
  if (enigmaAutoTimer !== null) {
    clearInterval(enigmaAutoTimer);
    enigmaAutoTimer = null;
    $('enigma-auto').textContent = 'Animate message';
    return;
  }
  if (!enigmaStepper) resetEnigmaStepper();
  $('enigma-auto').textContent = 'Pause animation';
  enigmaAutoTimer = setInterval(() => {
    const before = enigmaStepIndex;
    stepEnigma();
    if (before === enigmaStepIndex || enigmaStepIndex >= enigmaStepText.length) {
      clearInterval(enigmaAutoTimer);
      enigmaAutoTimer = null;
      $('enigma-auto').textContent = 'Animate message';
    }
  }, 520);
}

function renderEnigmaTrace(trace) {
  const shell = $('enigma-visual');
  const details = $('enigma-trace');
  if (!trace) {
    shell.innerHTML = '<div class="hint">Use "Show next letter" or "Animate message" to watch one typed letter go through the plugboard, rotors, reflector, and output bulbs.</div>';
    details.innerHTML = '<span class="hint">No letter shown yet.</span>';
    return;
  }

  const stages = trace.stages.map((stage, i) => ({
    ...stage,
    beforeLetter: i === 0 ? stage.letter : trace.stages[i - 1].letter
  }));
  const top = stages.slice(0, 6);
  const bottom = stages.slice(6);
  const topXs = [82, 205, 328, 451, 574, 697];
  const bottomXs = [574, 451, 328, 205, 82];
  const topY = 132;
  const bottomY = 278;
  const boxW = 112;
  const boxH = 82;
  const width = 780;
  const height = 362;

  function stageValue(stage) {
    if (stage.name === 'Key pressed' || stage.beforeLetter === stage.letter) return stage.letter;
    return `${stage.beforeLetter}→${stage.letter}`;
  }

  function rotorWindowForStage(stage) {
    if (stage.name.startsWith('Left rotor')) return trace.afterStep[0];
    if (stage.name.startsWith('Middle rotor')) return trace.afterStep[1];
    if (stage.name.startsWith('Right rotor')) return trace.afterStep[2];
    return '';
  }

  function stageDetail(stage) {
    const before = stage.beforeLetter;
    const after = stage.letter;
    if (stage.name === 'Key pressed') return 'typed key';
    if (stage.name === 'Plugboard in' || stage.name === 'Plugboard out') return before === after ? 'no cable' : `cable ${before}-${after}`;
    if (stage.name.startsWith('Right rotor') || stage.name.startsWith('Middle rotor') || stage.name.startsWith('Left rotor')) return 'wired wheel';
    if (stage.name.startsWith('Reflector')) return 'sends back';
    if (stage.name === 'Lamp lit') return 'output bulb';
    return '';
  }

  function stageBox(stage, x, y) {
    const label = shortStageName(stage.name);
    const value = stageValue(stage);
    const detail = stageDetail(stage);
    const window = rotorWindowForStage(stage);
    const windowTab = window ? `
      <rect class="rotor-window-tab" x="${x - 38}" y="${y - boxH / 2 - 22}" width="76" height="24" rx="9"></rect>
      <text class="rotor-window-tab-text" x="${x}" y="${y - boxH / 2 - 6}">window ${window}</text>` : '';
    return `
      <g>
        <title>${escapeHtml(stagePlainEnglish(stage.name))}</title>
        ${windowTab}
        <rect class="stage-box ${stage.kind} active" x="${x - boxW / 2}" y="${y - boxH / 2}" width="${boxW}" height="${boxH}" rx="14"></rect>
        <text class="stage-label" x="${x}" y="${y - 24}">${escapeHtml(label)}</text>
        <text class="stage-letter" x="${x}" y="${y + 5}">${escapeHtml(value)}</text>
        <text class="stage-detail" x="${x}" y="${y + 27}">${escapeHtml(detail)}</text>
      </g>`;
  }

  const topBoxes = top.map((stage, i) => stageBox(stage, topXs[i], topY)).join('');
  const bottomBoxes = bottom.map((stage, i) => stageBox(stage, bottomXs[i], bottomY)).join('');

  const forwardLines = topXs.slice(0, -1).map((x, i) => {
    const x1 = x + boxW / 2;
    const x2 = topXs[i + 1] - boxW / 2;
    return `<path class="path-line forward-path" d="M ${x1} ${topY} L ${x2} ${topY}"></path>`;
  }).join('');

  const returnDrop = `<path class="path-line return-path" d="M ${697} ${topY + boxH / 2} C ${742} ${190}, ${662} ${226}, ${574} ${bottomY - boxH / 2}"></path>`;

  const returnLines = bottomXs.slice(0, -1).map((x, i) => {
    const x1 = x - boxW / 2;
    const x2 = bottomXs[i + 1] + boxW / 2;
    return `<path class="path-line return-path" d="M ${x1} ${bottomY} L ${x2} ${bottomY}"></path>`;
  }).join('');

  shell.innerHTML = `
    <svg class="enigma-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Enigma signal path">
      <defs>
        <marker id="arrow-forward" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
          <path d="M 0 0 L 8 3 L 0 6 z" fill="#45685f"></path>
        </marker>
        <marker id="arrow-return" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
          <path d="M 0 0 L 8 3 L 0 6 z" fill="#7a5a45"></path>
        </marker>
      </defs>
      <g>${forwardLines}${returnDrop}${returnLines}</g>
      ${topBoxes}
      ${bottomBoxes}
    </svg>`;

  details.innerHTML = '';
}

function shortStageName(name) {
  if (name === 'Key pressed') return 'Key';
  if (name === 'Plugboard in') return 'Plugboard in';
  if (name === 'Plugboard out') return 'Plugboard out';
  if (name.startsWith('Right rotor') && !name.includes('return')) return 'Right rotor';
  if (name.startsWith('Middle rotor') && !name.includes('return')) return 'Middle rotor';
  if (name.startsWith('Left rotor') && !name.includes('return')) return 'Left rotor';
  if (name.startsWith('Reflector')) return 'Reflector';
  if (name.startsWith('Left rotor') && name.includes('return')) return 'Left rotor';
  if (name.startsWith('Middle rotor') && name.includes('return')) return 'Middle rotor';
  if (name.startsWith('Right rotor') && name.includes('return')) return 'Right rotor';
  if (name === 'Lamp lit') return 'Output bulb';
  return name;
}

function stagePlainEnglish(name) {
  if (name === 'Key pressed') return 'The operator presses this letter key.';
  if (name === 'Plugboard in') return 'The plugboard is the front socket board. If this letter has a cable, the cable swaps it with the other end.';
  if (name.startsWith('Right rotor') && !name.includes('return')) return 'The signal enters the fast right rotor.';
  if (name.startsWith('Middle rotor') && !name.includes('return')) return 'The signal passes through the middle rotor.';
  if (name.startsWith('Left rotor') && !name.includes('return')) return 'The signal passes through the slow left rotor.';
  if (name.startsWith('Reflector')) return 'The reflector is part of every encryption. It changes the signal once and sends it back through the rotors by a return path.';
  if (name.startsWith('Left rotor') && name.includes('return')) return 'The signal comes back through the left rotor in reverse.';
  if (name.startsWith('Middle rotor') && name.includes('return')) return 'The signal comes back through the middle rotor in reverse.';
  if (name.startsWith('Right rotor') && name.includes('return')) return 'The signal comes back through the right rotor in reverse.';
  if (name === 'Plugboard out') return 'The plugboard swaps the returning letter again.';
  if (name === 'Lamp lit') return 'This is the output bulb. Enigma has one bulb for each letter; the lit bulb is the encrypted letter.';
  return name;
}

function setBombeExample() {
  const settings = {
    rotors: ['I', 'II', 'III'],
    reflector: 'B',
    ringSettings: 'AAA',
    positions: 'MCK',
    plugboardPairs: DEFAULT_PLUGBOARD_PAIRS
  };
  const plaintext = 'WEATHERREPORTATDAWN';
  const machine = new EnigmaMachine(settings);
  const ciphertext = machine.encode(plaintext).output;

  $('bombe-ciphertext').value = ciphertext;
  $('bombe-crib').value = plaintext;
  $('bombe-offset').value = '0';
  $('bombe-left-rotor').value = 'I';
  $('bombe-middle-rotor').value = 'II';
  $('bombe-right-rotor').value = 'III';
  $('bombe-reflector').value = 'B';
  $('bombe-rings').value = 'AAA';
  if ($('bombe-search-mode')) $('bombe-search-mode').value = 'standard';
  $('bombe-scope').value = 'orders-both-reflectors';
  $('bombe-decoded').value = '';
  bombeStops = [];
  renderStops();
  setProgress(0);
  buildAndRenderMenu('MCK');
  showPossibleOffsets();
  showReady('Ready', 'bombe-state-pill');
  updateSearchSummary();
  $('bombe-status').textContent = 'Default inputs loaded. The standard search fixes the ring setting at AAA; use an all-ring mode only when you want the much larger search.';
  $('bombe-status').className = 'status-box';
}

function possibleOffsets(ciphertext, crib) {
  const cleanCipher = sanitize(ciphertext);
  const cleanCrib = sanitize(crib);
  const out = [];
  if (!cleanCipher || !cleanCrib || cleanCrib.length > cleanCipher.length) return out;
  for (let offset = 0; offset <= cleanCipher.length - cleanCrib.length; offset += 1) {
    let possible = true;
    for (let i = 0; i < cleanCrib.length; i += 1) {
      if (cleanCrib[i] === cleanCipher[offset + i]) {
        possible = false;
        break;
      }
    }
    if (possible) out.push(offset);
  }
  return out;
}

function showPossibleOffsets() {
  const offsets = possibleOffsets($('bombe-ciphertext').value, $('bombe-crib').value);
  if (!offsets.length) {
    $('offset-help').innerHTML = 'No possible crib positions found. In every placement, at least one guessed letter would sit above the same ciphertext letter. Enigma cannot encrypt a letter as itself.';
    return;
  }
  $('offset-help').innerHTML = `<strong>Crib can fit at these positions</strong><div class="offset-buttons">${offsets.map((o) => `<button class="offset-button${String(o) === $('bombe-offset').value ? ' selected' : ''}" data-offset="${o}">${o}</button>`).join('')}</div><span class="hint">A number says how many ciphertext letters come before the guessed crib. The search checks every listed number automatically. Click one only to preview the menu.</span>`;
}

function buildAndRenderMenu(position = 'AAA') {
  try {
    const settings = getBombeBaseSettings();
    currentMenu = buildMenu(
      $('bombe-ciphertext').value,
      $('bombe-crib').value,
      $('bombe-offset').value,
      settings.rotors,
      settings.reflector,
      settings.ringSettings,
      position
    );
    renderCribAlignment(currentMenu);
    renderMenuGraph(currentMenu);
    renderAssumptionGrid(null);
    $('stop-details').innerHTML = '<div class="hint">Run the search to see which assumptions survive for a stop.</div>';
    showReady('Wiring plan shown', 'bombe-state-pill');
  } catch (error) {
    showError(error.message, 'bombe-state-pill');
    $('bombe-status').textContent = error.message;
    $('bombe-status').className = 'status-box error';
  }
}


function indexToComponents(index) {
  const l = Math.floor(index / (26 * 26));
  const m = Math.floor((index % (26 * 26)) / 26);
  const r = index % 26;
  return [l, m, r];
}

function componentsToIndex(l, m, r) {
  return l * 26 * 26 + m * 26 + r;
}

function stepPositionIndex(index, rotors) {
  let [l, m, r] = indexToComponents(index);
  const middleAtNotch = ROTOR_NOTCHES[rotors[1]].has(m);
  const rightAtNotch = ROTOR_NOTCHES[rotors[2]].has(r);
  if (middleAtNotch) l = mod26(l + 1);
  if (rightAtNotch || middleAtNotch) m = mod26(m + 1);
  r = mod26(r + 1);
  return componentsToIndex(l, m, r);
}

function corePermutationAtIndex(rotors, reflector, ringSettings, index) {
  const pos = indexToComponents(index);
  const rings = ringSettings.split('').map(charToInt);
  const reflectorWiring = REFLECTOR_WIRINGS[reflector];
  const perm = Array(26);

  function encodeRotor(c, rotorSlot, backward) {
    const rotorName = rotors[rotorSlot];
    const wiring = backward ? ROTOR_INVERSE_WIRINGS[rotorName] : ROTOR_WIRINGS[rotorName];
    const shifted = mod26(c + pos[rotorSlot] - rings[rotorSlot]);
    const wired = wiring[shifted];
    return mod26(wired - pos[rotorSlot] + rings[rotorSlot]);
  }

  for (let x = 0; x < 26; x += 1) {
    let c = x;
    c = encodeRotor(c, 2, false);
    c = encodeRotor(c, 1, false);
    c = encodeRotor(c, 0, false);
    c = reflectorWiring[c];
    c = encodeRotor(c, 0, true);
    c = encodeRotor(c, 1, true);
    c = encodeRotor(c, 2, true);
    perm[x] = c;
  }

  return perm;
}

async function buildPermutationCache(rotors, reflector, ringSettings, searchToken) {
  const cache = Array(26 * 26 * 26);
  for (let i = 0; i < cache.length; i += 1) {
    if (cancelBombeSearch || activeSearchToken !== searchToken) throw new Error('Search stopped.');
    cache[i] = corePermutationAtIndex(rotors, reflector, ringSettings, i);
    if (i % 1800 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return cache;
}

function buildFastMenu(ciphertext, crib, offset) {
  const cleanCipher = sanitize(ciphertext);
  const cleanCrib = sanitize(crib);
  const numericOffset = Number.parseInt(offset, 10);
  if (!cleanCipher) throw new Error('Ciphertext must contain letters.');
  if (!cleanCrib) throw new Error('Crib must contain letters.');
  if (!Number.isInteger(numericOffset) || numericOffset < 0) throw new Error('Offset must be a non-negative integer.');
  if (numericOffset + cleanCrib.length > cleanCipher.length) throw new Error('The crib does not fit at this offset.');

  const links = [];
  const noSelfEncryptionFailures = [];
  for (let i = 0; i < cleanCrib.length; i += 1) {
    const plainLetter = cleanCrib[i];
    const cipherLetter = cleanCipher[numericOffset + i];
    if (plainLetter === cipherLetter) noSelfEncryptionFailures.push(i);
    links.push({
      index: i,
      step: numericOffset + i + 1,
      plain: charToInt(plainLetter),
      cipher: charToInt(cipherLetter),
      plainLetter,
      cipherLetter
    });
  }

  const degree = Array(26).fill(0);
  for (const link of links) {
    degree[link.plain] += 1;
    degree[link.cipher] += 1;
  }
  let testLetter = links[0].plain;
  for (let i = 0; i < 26; i += 1) {
    if (degree[i] > degree[testLetter]) testLetter = i;
  }

  return {
    ciphertext: cleanCipher,
    crib: cleanCrib,
    offset: numericOffset,
    links,
    noSelfEncryptionFailures,
    testLetter,
    maxStep: links.length ? links[links.length - 1].step : 0
  };
}

function permsForStartIndex(startIndex, rotors, permCache, fastMenu) {
  const perms = [];
  let currentIndex = startIndex;
  let linkIndex = 0;

  for (let step = 1; step <= fastMenu.maxStep; step += 1) {
    currentIndex = stepPositionIndex(currentIndex, rotors);
    while (linkIndex < fastMenu.links.length && fastMenu.links[linkIndex].step === step) {
      perms.push(permCache[currentIndex]);
      linkIndex += 1;
    }
  }

  return perms;
}

function testFastMenuPosition(fastMenu, perms) {
  if (fastMenu.noSelfEncryptionFailures.length > 0) return null;

  const dsu = new DSU(DIAGONAL_BASE.parent, DIAGONAL_BASE.rank);
  for (let i = 0; i < fastMenu.links.length; i += 1) {
    const link = fastMenu.links[i];
    const perm = perms[i];
    for (let x = 0; x < 26; x += 1) {
      dsu.union(nodeIndex(link.plain, x), nodeIndex(link.cipher, perm[x]));
    }
  }

  const rowMasks = new Map();
  const badRoots = new Set();
  for (let n = 0; n < NODE_COUNT; n += 1) {
    const row = Math.floor(n / 26);
    const root = dsu.find(n);
    const bit = 1 << row;
    const current = rowMasks.get(root) || 0;
    if (current & bit) badRoots.add(root);
    rowMasks.set(root, current | bit);
  }

  const survivors = [];
  for (let value = 0; value < 26; value += 1) {
    const root = dsu.find(nodeIndex(fastMenu.testLetter, value));
    if (!badRoots.has(root)) {
      const mapping = componentMapping(dsu, root);
      if (mapping) survivors.push({ value, mapping });
    }
  }

  if (!survivors.length) return null;
  const chosen = survivors.slice().sort((a, b) => {
    const mappedA = a.mapping.filter((x) => x !== -1).length;
    const mappedB = b.mapping.filter((x) => x !== -1).length;
    return mappedB - mappedA;
  })[0];
  const formatted = formatPartialPlugboard(chosen.mapping);

  return {
    isStop: true,
    testLetter: fastMenu.testLetter,
    survivors: survivors.map((item) => intToChar(item.value)),
    mapping: chosen.mapping,
    pairs: formatted.pairs,
    fixed: formatted.fixed,
    unknown: formatted.unknown
  };
}

function getSearchWork(settings) {
  const rotorNames = Object.keys(ROTOR_SPECS);
  const scope = $('bombe-scope').value;
  let rotorOrders;
  let reflectors;

  if (scope === 'selected') rotorOrders = [settings.rotors];
  else rotorOrders = permutations(rotorNames, 3);

  if (scope === 'orders-both-reflectors') reflectors = Object.keys(REFLECTORS);
  else reflectors = [settings.reflector];

  return { rotorOrders, reflectors, total: rotorOrders.length * reflectors.length * 26 * 26 * 26 };
}

function setProgress(fraction) {
  $('bombe-progress').style.width = `${Math.max(0, Math.min(100, fraction * 100)).toFixed(2)}%`;
}

function stopFromWorkerStop(workerStop, captured) {
  const menu = buildMenu(
    captured.ciphertext,
    captured.crib,
    workerStop.offset,
    workerStop.rotors,
    workerStop.reflector,
    workerStop.ringSettings,
    workerStop.positions
  );
  return {
    rotors: workerStop.rotors,
    reflector: workerStop.reflector,
    ringSettings: workerStop.ringSettings,
    positions: workerStop.positions,
    offset: workerStop.offset,
    testLetter: workerStop.testLetter,
    survivorValues: workerStop.survivorValues,
    pairs: workerStop.pairs,
    fixed: workerStop.fixed,
    unknown: workerStop.unknown,
    mapping: workerStop.mapping,
    menu
  };
}

function finishBombeSearch() {
  $('bombe-search').disabled = false;
  $('bombe-cancel').disabled = true;
  bombeWorker = null;
}

function stopRankingScore(stop) {
  return (stop.pairs.length * 6) + stop.fixed.length - stop.unknown.length;
}

function sortBombeStopsInPlace() {
  bombeStops.sort((a, b) => {
    const diff = stopRankingScore(b) - stopRankingScore(a);
    if (diff !== 0) return diff;
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (a.positions !== b.positions) return a.positions.localeCompare(b.positions);
    return a.rotors.join('-').localeCompare(b.rotors.join('-'));
  });
}

function menuMetricText(stats) {
  return `${stats.edges} crib column${stats.edges === 1 ? '' : 's'} tested, ${stats.vertexCount} letter socket${stats.vertexCount === 1 ? '' : 's'} involved, ${stats.cycles} closed circuit${stats.cycles === 1 ? '' : 's'}.`;
}

function menuMetricExplanation(stats) {
  if (stats.cycles === 0) {
    return 'No closed circuit: this crib gives the Bombe little structure, so many false stops can survive.';
  }
  return 'Closed circuits give the Bombe stronger contradiction tests, so fewer false stops tend to survive.';
}

function searchBombePositions() {
  if (bombeWorker) {
    bombeWorker.terminate();
    bombeWorker = null;
  }

  try {
    keepLettersOnly('bombe-rings', 3);
    const config = getBombeSearchConfig();
    const settings = config.settings;
    $('bombe-scope').value = config.scope;
    const captured = {
      ciphertext: sanitize($('bombe-ciphertext').value),
      crib: sanitize($('bombe-crib').value),
      offset: $('bombe-offset').value
    };

    if (captured.crib.length === 0) {
      throw new Error('Enter a crib: a guessed word or phrase from the original plaintext.');
    }

    const offsets = possibleOffsets(captured.ciphertext, captured.crib);
    if (!offsets.length) {
      throw new Error("No possible crib positions. Every placement is immediately ruled out by Enigma's no-self-encryption rule.");
    }

    const plannedTotal = estimateTestCount(config, offsets);
    const payload = {
      ciphertext: captured.ciphertext,
      crib: captured.crib,
      offsets,
      previewOffset: captured.offset,
      rotors: settings.rotors,
      reflector: settings.reflector,
      ringSettings: settings.ringSettings,
      allRings: config.allRings,
      scope: config.scope,
      maxStops: MAX_BOMBE_STOPS,
      maxStopsPerOffset: MAX_STOPS_PER_CRIB_POSITION
    };

    bombeStops = [];
    renderStops();
    $('bombe-decoded').value = '';
    $('bombe-search').disabled = true;
    $('bombe-cancel').disabled = false;
    $('bombe-status').textContent = captured.crib.length < 10
      ? `Starting ${config.modeLabel}. Planned tests: ${plannedTotal.toLocaleString()}. This crib is short, so expect many false stops.`
      : `Starting ${config.modeLabel}. Planned tests: ${plannedTotal.toLocaleString()}. The page will stay usable while the worker runs.`;
    $('bombe-status').className = 'status-box working';
    showReady('Searching...', 'bombe-state-pill');
    setProgress(0);
    updateSearchSummary();

    if (!window.Worker) {
      throw new Error('This browser does not support Web Workers. Try a modern browser or run a smaller search.');
    }

    bombeWorker = new Worker('bombe-worker.js');
    bombeWorker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'started') {
        $('bombe-status').textContent = `${config.modeLabel}. Planned tests: ${message.total.toLocaleString()}. Candidate stops found so far: 0.`
          + (config.allRings ? ' Exhaustive ring search may be very slow.' : '')
          + (captured.crib.length < 10 ? ' Short crib: expect many false candidates.' : '');
        setProgress(0);
      } else if (message.type === 'phase') {
        $('bombe-status').textContent = `${message.message} Candidate stops stored: ${bombeStops.length}.`;
      } else if (message.type === 'progress') {
        setProgress(message.checked / message.total);
        $('bombe-status').textContent = progressMessage(message.checked, message.total, message.seconds, bombeStops.length);
      } else if (message.type === 'stop') {
        const stop = stopFromWorkerStop(message.stop, captured);
        bombeStops.push(stop);
        sortBombeStopsInPlace();
        renderStops();
        if (bombeStops.length === 1) {
          $('bombe-stops').selectedIndex = 0;
          renderSelectedStop();
        }
      } else if (message.type === 'done') {
        setProgress(1);
        const elapsed = formatDuration(Number.parseFloat(message.seconds));
        $('bombe-status').textContent = message.limited
          ? `Stopped after storing the first ${bombeStops.length} candidate stops in ${elapsed}. At least ${(message.totalStopsSeen || bombeStops.length).toLocaleString()} stops were already appearing, which usually means the crib is too weak and many settings survive. A stop is only a candidate to check, not automatically the answer.`
          : `Search complete in ${elapsed}. Candidate stops found: ${bombeStops.length}.`;
        $('bombe-status').className = 'status-box';
        showReady(`Candidate stops: ${bombeStops.length}`, 'bombe-state-pill');
        if (bombeStops.length > 0) {
          $('bombe-stops').selectedIndex = 0;
          renderSelectedStop();
        }
        finishBombeSearch();
      } else if (message.type === 'cancelled') {
        $('bombe-status').textContent = 'Search stopped.';
        $('bombe-status').className = 'status-box';
        showReady('Search stopped', 'bombe-state-pill');
        finishBombeSearch();
      } else if (message.type === 'error') {
        $('bombe-status').textContent = message.message;
        $('bombe-status').className = 'status-box error';
        showError(message.message, 'bombe-state-pill');
        finishBombeSearch();
      }
    };

    bombeWorker.onerror = (error) => {
      $('bombe-status').textContent = error.message || 'Worker search failed.';
      $('bombe-status').className = 'status-box error';
      showError('Worker search failed.', 'bombe-state-pill');
      if (bombeWorker) bombeWorker.terminate();
      finishBombeSearch();
    };

    bombeWorker.postMessage({ type: 'start', payload });
  } catch (error) {
    $('bombe-status').textContent = error.message;
    $('bombe-status').className = 'status-box error';
    showError(error.message, 'bombe-state-pill');
    finishBombeSearch();
  }
}


function renderStops() {
  const select = $('bombe-stops');
  select.innerHTML = '';
  bombeStops.forEach((stop, i) => {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = `${i + 1}. windows ${stop.positions}, rotors ${stop.rotors.join('-')}, reflector ${stop.reflector}, rings ${stop.ringSettings}, crib position ${stop.offset}, forced wires ${stop.pairs.length}, unresolved ${stop.unknown.length}`;
    select.appendChild(option);
  });
}

function renderSelectedStop() {
  const index = Number.parseInt($('bombe-stops').value, 10);
  const stop = bombeStops[index];
  if (!stop) {
    $('stop-details').innerHTML = '<div class="hint">No stop selected.</div>';
    renderAssumptionGrid(null);
    return;
  }
  currentMenu = stop.menu;
  renderCribAlignment(stop.menu);
  renderMenuGraph(stop.menu);
  renderAssumptionGrid(stop);
  const stats = menuGraphStats(stop.menu);

  $('stop-details').innerHTML = `
    <dl class="trace-grid">
      <dt>Result</dt><dd>This candidate survived the menu contradiction test. The first two decode buttons test this selected stop only.</dd>
      <dt>Menu</dt><dd>${menuMetricText(stats)} ${menuMetricExplanation(stats)}</dd>
      <dt>Rotor order</dt><dd>${stop.rotors.join('-')}</dd>
      <dt>Reflector</dt><dd>${stop.reflector}</dd>
      <dt>Ring settings</dt><dd>${stop.ringSettings}</dd>
      <dt>Start windows</dt><dd>${stop.positions}</dd>
      <dt>Probe letter</dt><dd>${stop.testLetter}</dd>
      <dt>Probe values not contradicted</dt><dd>${stop.survivorValues.join(' ')}</dd>
      <dt>Recovered plugboard wires</dt><dd>${stop.pairs.join(' ') || '(none forced by this crib yet)'}</dd>
      <dt>Letters forced unplugged</dt><dd>${stop.fixed.join(' ') || '(none)'}</dd>
      <dt>Letters still unresolved</dt><dd>${stop.unknown.join(' ') || '(none)'}</dd>
    </dl>`;
}

function decodeSelectedStop() {
  const index = Number.parseInt($('bombe-stops').value, 10);
  const stop = bombeStops[index];
  if (!stop) return;
  try {
    const stats = menuGraphStats(stop.menu);
    const warning = stats.cycles === 0 || stop.menu.crib.length < 10
      ? 'Warning: this is a weak crib for a Bombe search. This checks one surviving candidate only. A readable decode is not expected unless this selected stop is the real one.\n\n'
      : 'This checks the selected stop using only the plugboard wires forced by the crib. Unresolved letters are treated as unplugged.\n\n';
    $('bombe-decoded').value = warning + decodeWithStop($('bombe-ciphertext').value, stop, stop.pairs);
  } catch (error) {
    $('bombe-decoded').value = error.message;
  }
}

function completeSelectedStop() {
  const index = Number.parseInt($('bombe-stops').value, 10);
  const stop = bombeStops[index];
  if (!stop) return;
  try {
    const stats = menuGraphStats(stop.menu);
    const candidates = completeAndDecode($('bombe-ciphertext').value, stop, 10);
    if (candidates.length === 0) {
      $('bombe-decoded').value = 'No plugboard completions found for this selected stop.';
      return;
    }
    const header = [
      'Completions for the selected stop only.',
      `Menu: ${menuMetricText(stats)}`,
      menuMetricExplanation(stats),
      ''
    ];
    $('bombe-decoded').value = header.concat(candidates.map((candidate, i) => [
      `Completion ${i + 1}, score ${candidate.score}`,
      `Plugboard completion tried: ${candidate.pairs.join(' ')}`,
      `Decoded text for this selected stop: ${candidate.plaintext}`
    ].join('\n'))).join('\n\n');
  } catch (error) {
    $('bombe-decoded').value = error.message;
  }
}

function completeListedStops() {
  if (!bombeStops.length) return;
  try {
    const ciphertext = $('bombe-ciphertext').value;
    const allCandidates = [];
    for (let i = 0; i < bombeStops.length; i += 1) {
      const stop = bombeStops[i];
      const candidates = completeAndDecode(ciphertext, stop, 10).slice(0, 3);
      for (const candidate of candidates) {
        allCandidates.push({ stopIndex: i + 1, stop, ...candidate });
      }
    }
    allCandidates.sort((a, b) => b.score - a.score);
    const top = allCandidates.slice(0, 40);
    $('bombe-decoded').value = [
      `Tried completions for ${bombeStops.length.toLocaleString()} listed stop${bombeStops.length === 1 ? '' : 's'}.`,
      'Showing the 40 highest-scoring decoded outputs. With a weak crib, many will still be gibberish.',
      ''
    ].concat(top.map((candidate, i) => [
      `Overall candidate ${i + 1}, score ${candidate.score}`,
      `From stop ${candidate.stopIndex}: windows ${candidate.stop.positions}, rotors ${candidate.stop.rotors.join('-')}, reflector ${candidate.stop.reflector}, rings ${candidate.stop.ringSettings}, crib position ${candidate.stop.offset}`,
      `Plugboard completion tried: ${candidate.pairs.join(' ')}`,
      `Decoded text: ${candidate.plaintext}`
    ].join('\n'))).join('\n\n');
  } catch (error) {
    $('bombe-decoded').value = error.message;
  }
}

function renderCribAlignment(menu) {
  const target = $('crib-alignment');
  if (!menu) {
    target.innerHTML = '<div class="hint">No crib menu yet.</div>';
    return;
  }

  const indices = Array.from({ length: menu.crib.length }, (_, i) => i + menu.offset);
  const header = indices.map((i) => `<th>${i}</th>`).join('');
  const plain = menu.crib.split('').map((ch, i) => `<td${ch === menu.cipherSlice[i] ? ' class="collision"' : ''}>${ch}</td>`).join('');
  const cipher = menu.cipherSlice.split('').map((ch, i) => `<td${ch === menu.crib[i] ? ' class="collision"' : ''}>${ch}</td>`).join('');

  target.innerHTML = `
    <table class="alignment-table">
      <tr><th>Position</th>${header}</tr>
      <tr><th>Guessed plaintext</th>${plain}</tr>
      <tr><th>Ciphertext</th>${cipher}</tr>
    </table>
    ${menu.noSelfEncryptionFailures.length ? '<p class="hint">Red cells are impossible because Enigma cannot encrypt a letter as itself.</p>' : '<p class="hint">Each column becomes one line in the menu graph: guessed letter to ciphertext letter.</p>'}`;
}

function renderMenuGraph(menu) {
  const target = $('menu-graph');
  if (!menu) {
    target.innerHTML = '<div class="hint">No menu yet.</div>';
    return;
  }

  const width = 700;
  const height = 184;
  const activeLetters = new Set(menu.constraints.flatMap((edge) => [edge.plainLetter, edge.cipherLetter]));

  const wires = menu.constraints.map((edge) => {
    const a = plugboardCoordinates(edge.plainLetter);
    const b = plugboardCoordinates(edge.cipherLetter);
    const midY = Math.min(a.y, b.y) - 34;
    const path = `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
    return `<path class="plug-wire-shadow" d="${path}"></path><path class="plug-wire" d="${path}"></path>`;
  }).join('');

  const sockets = ALPHABET.split('').map((letter) => {
    const p = plugboardCoordinates(letter);
    const classes = ['socket'];
    if (activeLetters.has(letter)) classes.push('used');
    else classes.push('unused');
    return `
      <g class="${classes.join(' ')}">
        <circle cx="${p.x}" cy="${p.y}" r="18"></circle>
        <text x="${p.x}" y="${p.y + 1}">${letter}</text>
      </g>`;
  }).join('');

  const stats = menuGraphStats(menu);
  target.innerHTML = `
    <div class="plugboard-physical menu-board">
      <svg class="plugboard-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bombe menu shown with the same letter sockets as the plugboard">
        ${wires}
        ${sockets}
      </svg>
    </div>
    <div class="menu-stats">${stats.edges} crib column${stats.edges === 1 ? '' : 's'} drawn as lines, ${stats.vertexCount} letter socket${stats.vertexCount === 1 ? '' : 's'} used, ${stats.cycles} closed circuit${stats.cycles === 1 ? '' : 's'}.</div>`;
}

function renderAssumptionGrid(stop) {
  const target = $('assumption-grid');
  if (!stop) {
    target.innerHTML = '<div class="hint">Select a stop to see which probe values survived the diagonal-board contradiction test.</div>';
    return;
  }
  const survivors = new Set(stop.survivorValues);
  target.innerHTML = ALPHABET.split('').map((letter) => {
    const cls = survivors.has(letter) ? 'survives' : 'contradiction';
    return `<div class="assumption ${cls}">${stop.testLetter} ↔ ${letter}</div>`;
  }).join('');
}

function populateControls() {
  const rotorNames = Object.keys(ROTOR_SPECS);
  const reflectorNames = Object.keys(REFLECTORS);

  setSelectOptions($('enigma-left-rotor'), rotorNames, 'I');
  setSelectOptions($('enigma-middle-rotor'), rotorNames, 'II');
  setSelectOptions($('enigma-right-rotor'), rotorNames, 'III');
  setSelectOptions($('enigma-reflector'), reflectorNames, 'B');

  setSelectOptions($('bombe-left-rotor'), rotorNames, 'I');
  setSelectOptions($('bombe-middle-rotor'), rotorNames, 'II');
  setSelectOptions($('bombe-right-rotor'), rotorNames, 'III');
  setSelectOptions($('bombe-reflector'), reflectorNames, 'B');
}

function setupTabs() {
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      button.classList.add('active');
      $(button.dataset.tab).classList.add('active');
    });
  });
}

function resetBombeInputsChanged() {
  if (bombeWorker) {
    bombeWorker.terminate();
    bombeWorker = null;
  }
  bombeStops = [];
  renderStops();
  renderSelectedStop();
  $('bombe-decoded').value = '';
  setProgress(0);
  showPossibleOffsets();
  updateSearchSummary();
  const offsets = possibleOffsets($('bombe-ciphertext').value, $('bombe-crib').value);
  if (offsets.length) {
    $('bombe-offset').value = String(offsets[offsets.length - 1]);
    buildAndRenderMenu('AAA');
    $('bombe-status').textContent = 'Inputs changed. Run the search again to get fresh stops.';
    $('bombe-status').className = 'status-box';
  } else {
    $('bombe-status').textContent = 'No possible crib position for these inputs yet.';
    $('bombe-status').className = 'status-box';
  }
}

function attachEvents() {
  $('plugboard-physical').addEventListener('click', (event) => {
    const socket = event.target.closest('[data-letter]');
    if (socket) handlePlugboardClick(socket.dataset.letter);
  });

  $('plugboard-physical').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const socket = event.target.closest('[data-letter]');
    if (socket) {
      event.preventDefault();
      handlePlugboardClick(socket.dataset.letter);
    }
  });

  $('plugboard-random').addEventListener('click', () => setPlugboardPairs(randomPlugboardPairs(10)));
  $('plugboard-clear').addEventListener('click', () => setPlugboardPairs([]));

  $('enigma-random-settings').addEventListener('click', setRandomSettings);
  $('enigma-reset').addEventListener('click', resetEnigmaStepper);
  $('enigma-run').addEventListener('click', runEnigma);
  $('enigma-step').addEventListener('click', stepEnigma);
  $('enigma-auto').addEventListener('click', toggleAutoStep);

  ['enigma-rings', 'enigma-positions'].forEach((id) => {
    $(id).addEventListener('input', () => {
      keepLettersOnly(id, 3);
      resetEnigmaStepper();
    });
  });

  ['enigma-left-rotor', 'enigma-middle-rotor', 'enigma-right-rotor', 'enigma-reflector', 'enigma-input']
    .forEach((id) => $(id).addEventListener('input', resetEnigmaStepper));

  ['bombe-ciphertext', 'bombe-crib', 'bombe-offset']
    .forEach((id) => $(id).addEventListener('input', resetBombeInputsChanged));

  $('offset-help').addEventListener('click', (event) => {
    if (event.target.classList.contains('offset-button')) {
      $('bombe-offset').value = event.target.dataset.offset;
      document.querySelectorAll('.offset-button').forEach((button) => button.classList.remove('selected'));
      event.target.classList.add('selected');
      buildAndRenderMenu('AAA');
      $('bombe-status').textContent = `Previewing crib position ${event.target.dataset.offset}. The Bombe search still checks every possible position.`;
      $('bombe-status').className = 'status-box';
    }
  });

  ['bombe-search-mode', 'bombe-rings', 'bombe-left-rotor', 'bombe-middle-rotor', 'bombe-right-rotor', 'bombe-reflector']
    .forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', () => {
        if (id === 'bombe-rings') keepLettersOnly(id, 3);
        updateSearchSummary();
      });
    });

  $('bombe-search').addEventListener('click', searchBombePositions);
  $('bombe-cancel').addEventListener('click', () => {
    cancelBombeSearch = true;
    if (bombeWorker) {
      bombeWorker.postMessage({ type: 'cancel' });
      bombeWorker.terminate();
      bombeWorker = null;
    }
    $('bombe-status').textContent = 'Search stopped.';
    $('bombe-status').className = 'status-box';
    $('bombe-search').disabled = false;
    $('bombe-cancel').disabled = true;
    showReady('Search stopped', 'bombe-state-pill');
  });
  $('bombe-stops').addEventListener('change', renderSelectedStop);
  $('bombe-decode').addEventListener('click', decodeSelectedStop);
  $('bombe-complete').addEventListener('click', completeSelectedStop);
  $('bombe-complete-all').addEventListener('click', completeListedStops);
}

function init() {
  if (window.location.protocol === 'file:') {
    const warning = $('server-warning');
    warning.hidden = false;
    warning.innerHTML = 'Bombe search needs the page to be opened through a local web server or GitHub Pages. Do not double-click index.html for the full search.';
  }
  populateControls();
  setupTabs();
  attachEvents();
  renderPlugboard();
  setEnigmaExample();
  setBombeExample();
  updateSearchSummary();
}

init();
