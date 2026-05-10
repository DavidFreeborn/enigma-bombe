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

const ROTOR_WIRINGS = Object.fromEntries(Object.entries(ROTOR_SPECS).map(([name, spec]) => [name, spec.wiring.split('').map(charToInt)]));
const ROTOR_INVERSE_WIRINGS = {};
for (const [name, wiring] of Object.entries(ROTOR_WIRINGS)) {
  const inverse = Array(26).fill(0);
  wiring.forEach((out, input) => { inverse[out] = input; });
  ROTOR_INVERSE_WIRINGS[name] = inverse;
}
const ROTOR_NOTCHES = Object.fromEntries(Object.entries(ROTOR_SPECS).map(([name, spec]) => [name, new Set(spec.notch.split('').map(charToInt))]));
const REFLECTOR_WIRINGS = Object.fromEntries(Object.entries(REFLECTORS).map(([name, wiring]) => [name, wiring.split('').map(charToInt)]));

const NODE_COUNT = 26 * 26;
let cancelled = false;

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

function permutations(items, length) {
  if (length === 0) return [[]];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest, length - 1)) out.push([items[i], ...tail]);
  }
  return out;
}

function validateThreeLetters(value, label) {
  const cleaned = sanitize(value);
  if (cleaned.length !== 3) throw new Error(`${label} must contain exactly three letters.`);
  return cleaned;
}

function validateRotorOrder(rotors) {
  if (!Array.isArray(rotors) || rotors.length !== 3) throw new Error('Exactly three rotors are required.');
  if (new Set(rotors).size !== 3) {
    throw new Error('Choose three different rotors. A wartime rotor set had one copy of each rotor.');
  }
  return rotors;
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

function positionFromIndex(index) {
  const [l, m, r] = indexToComponents(index);
  return intToChar(l) + intToChar(m) + intToChar(r);
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

function nodeIndex(row, value) {
  return 26 * row + value;
}

class DSU {
  constructor(parent = null, rank = null) {
    this.parent = new Int16Array(NODE_COUNT);
    this.rank = new Int8Array(NODE_COUNT);
    if (parent) this.reset(parent, rank);
    else {
      for (let i = 0; i < NODE_COUNT; i += 1) this.parent[i] = i;
    }
  }

  reset(parent, rank) {
    this.parent.set(parent);
    this.rank.set(rank);
  }

  find(x) {
    const p = this.parent;
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

function corePermutationAtIndex(rotors, reflector, ringSettings, index, permOut, invOut, offset) {
  const pos = indexToComponents(index);
  const rings = ringSettings.split('').map(charToInt);
  const reflectorWiring = REFLECTOR_WIRINGS[reflector];

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
    permOut[offset + x] = c;
    invOut[offset + c] = x;
  }
}

function buildPermutationCache(rotors, reflector, ringSettings) {
  const perm = new Uint8Array(26 * 26 * 26 * 26);
  const inv = new Uint8Array(26 * 26 * 26 * 26);
  for (let i = 0; i < 26 * 26 * 26; i += 1) {
    if (cancelled) throw new Error('Search stopped.');
    corePermutationAtIndex(rotors, reflector, ringSettings, i, perm, inv, i * 26);
  }
  return { perm, inv };
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


function possibleOffsets(ciphertext, crib) {
  const cleanCipher = sanitize(ciphertext);
  const cleanCrib = sanitize(crib);
  const offsets = [];
  if (!cleanCipher || !cleanCrib || cleanCrib.length > cleanCipher.length) return offsets;
  for (let offset = 0; offset <= cleanCipher.length - cleanCrib.length; offset += 1) {
    let possible = true;
    for (let i = 0; i < cleanCrib.length; i += 1) {
      if (cleanCrib[i] === cleanCipher[offset + i]) {
        possible = false;
        break;
      }
    }
    if (possible) offsets.push(offset);
  }
  return offsets;
}

function menuCyclesForOffset(ciphertext, crib, offset) {
  const cleanCipher = sanitize(ciphertext);
  const cleanCrib = sanitize(crib);
  const vertices = new Set();
  const adjacency = new Map();
  for (let i = 0; i < cleanCrib.length; i += 1) {
    const a = cleanCrib[i];
    const b = cleanCipher[offset + i];
    vertices.add(a);
    vertices.add(b);
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
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
  return Math.max(0, cleanCrib.length - vertices.size + components);
}

function orderOffsets(offsets, previewOffset, ciphertext, crib) {
  const wanted = Number.parseInt(previewOffset, 10);
  const dedup = [...new Set(offsets)];
  dedup.sort((a, b) => {
    if (a === wanted && b !== wanted) return -1;
    if (b === wanted && a !== wanted) return 1;
    const cycleDiff = menuCyclesForOffset(ciphertext, crib, b) - menuCyclesForOffset(ciphertext, crib, a);
    if (cycleDiff !== 0) return cycleDiff;
    return a - b;
  });
  return dedup;
}

function allThreeLetterSettings() {
  const out = [];
  for (let a = 0; a < 26; a += 1) {
    for (let b = 0; b < 26; b += 1) {
      for (let c = 0; c < 26; c += 1) {
        out.push(intToChar(a) + intToChar(b) + intToChar(c));
      }
    }
  }
  return out;
}

function createSearchScratch() {
  return {
    dsu: new DSU(DIAGONAL_BASE.parent, DIAGONAL_BASE.rank),
    rowMasks: new Int32Array(NODE_COUNT),
    badRoots: new Uint8Array(NODE_COUNT)
  };
}

function mappingForRoot(dsu, root) {
  const mapping = Array(26).fill(-1);
  let count = 0;
  for (let n = 0; n < NODE_COUNT; n += 1) {
    if (dsu.find(n) === root) {
      const row = Math.floor(n / 26);
      const value = n % 26;
      if (mapping[row] === -1) {
        mapping[row] = value;
        count += 1;
      } else if (mapping[row] !== value) {
        return null;
      }
    }
  }
  return { mapping, count };
}

function testFastMenuPosition(fastMenu, rotors, cache, startIndex, scratch) {
  if (fastMenu.noSelfEncryptionFailures.length > 0) return null;

  const dsu = scratch.dsu;
  dsu.reset(DIAGONAL_BASE.parent, DIAGONAL_BASE.rank);

  let currentIndex = startIndex;
  let linkIndex = 0;
  for (let step = 1; step <= fastMenu.maxStep; step += 1) {
    currentIndex = stepPositionIndex(currentIndex, rotors);
    while (linkIndex < fastMenu.links.length && fastMenu.links[linkIndex].step === step) {
      const link = fastMenu.links[linkIndex];
      const permBase = currentIndex * 26;
      for (let x = 0; x < 26; x += 1) {
        dsu.union(nodeIndex(link.plain, x), nodeIndex(link.cipher, cache.perm[permBase + x]));
      }
      linkIndex += 1;
    }
  }

  const rowMasks = scratch.rowMasks;
  const badRoots = scratch.badRoots;
  rowMasks.fill(0);
  badRoots.fill(0);

  for (let n = 0; n < NODE_COUNT; n += 1) {
    const row = Math.floor(n / 26);
    const root = dsu.find(n);
    const bit = 1 << row;
    const current = rowMasks[root];
    if (current & bit) badRoots[root] = 1;
    rowMasks[root] = current | bit;
  }

  let best = null;
  const survivorValues = [];
  for (let value = 0; value < 26; value += 1) {
    const root = dsu.find(nodeIndex(fastMenu.testLetter, value));
    if (!badRoots[root]) {
      const candidate = mappingForRoot(dsu, root);
      if (candidate) {
        survivorValues.push(intToChar(value));
        if (!best || candidate.count > best.count) best = candidate;
      }
    }
  }

  if (!best) return null;
  const formatted = formatPartialPlugboard(best.mapping);
  return {
    testLetter: intToChar(fastMenu.testLetter),
    survivorValues,
    pairs: formatted.pairs,
    fixed: formatted.fixed,
    unknown: formatted.unknown,
    mapping: best.mapping
  };
}

function getSearchWork(settings, offsets, ringSettingsList) {
  const rotorNames = Object.keys(ROTOR_SPECS);
  let rotorOrders;
  let reflectors;
  if (settings.scope === 'selected') rotorOrders = [settings.rotors];
  else rotorOrders = permutations(rotorNames, 3);
  if (settings.scope === 'orders-both-reflectors') reflectors = Object.keys(REFLECTORS);
  else reflectors = [settings.reflector];
  return {
    rotorOrders,
    reflectors,
    total: rotorOrders.length * reflectors.length * ringSettingsList.length * offsets.length * 26 * 26 * 26
  };
}

function runSearch(payload) {
  cancelled = false;
  const selectedRingSettings = validateThreeLetters(payload.ringSettings, 'Ring settings');
  const offsets = orderOffsets(
    Array.isArray(payload.offsets) && payload.offsets.length
      ? payload.offsets.map((x) => Number.parseInt(x, 10)).filter((x) => Number.isInteger(x) && x >= 0)
      : possibleOffsets(payload.ciphertext, payload.crib),
    payload.previewOffset,
    payload.ciphertext,
    payload.crib
  );
  if (!offsets.length) {
    throw new Error("No possible crib positions. Every placement is ruled out by Enigma's no-self-encryption rule.");
  }

  const ringSettingsList = payload.allRings ? allThreeLetterSettings() : [selectedRingSettings];

  const settings = {
    rotors: validateRotorOrder(payload.rotors),
    reflector: payload.reflector,
    ringSettings: selectedRingSettings,
    scope: payload.scope
  };
  const work = getSearchWork(settings, offsets, ringSettingsList);
  let checked = 0;
  let stopCount = 0;
  const maxStops = Number.isInteger(payload.maxStops) ? payload.maxStops : 250;
  const maxStopsPerOffset = Number.isInteger(payload.maxStopsPerOffset) ? payload.maxStopsPerOffset : maxStops;
  const started = Date.now();

  postMessage({ type: 'started', total: work.total });

  for (const rotors of work.rotorOrders) {
    for (const reflector of work.reflectors) {
      for (const ringSettings of ringSettingsList) {
        if (cancelled) throw new Error('Search stopped.');
        postMessage({
          type: 'phase',
          message: `Preparing rotor table for ${rotors.join('-')} reflector ${reflector}, rings ${ringSettings}.`
        });
        const permCache = buildPermutationCache(rotors, reflector, ringSettings);
        const scratch = createSearchScratch();
        for (const offset of offsets) {
          const fastMenu = buildFastMenu(payload.ciphertext, payload.crib, offset);
          if (fastMenu.noSelfEncryptionFailures.length > 0) continue;
          let stopsThisOffset = 0;
          for (let i = 0; i < 26 * 26 * 26; i += 1) {
            if (cancelled) throw new Error('Search stopped.');
            const stop = testFastMenuPosition(fastMenu, rotors, permCache, i, scratch);
            checked += 1;
            if (stop) {
              stopCount += 1;
              stopsThisOffset += 1;
              if (stopCount <= maxStops) {
                postMessage({
                  type: 'stop',
                  stop: {
                    rotors,
                    reflector,
                    ringSettings,
                    positions: positionFromIndex(i),
                    offset: fastMenu.offset,
                    testLetter: stop.testLetter,
                    survivorValues: stop.survivorValues,
                    pairs: stop.pairs,
                    fixed: stop.fixed,
                    unknown: stop.unknown,
                    mapping: stop.mapping
                  }
                });
              }
              if (stopsThisOffset >= maxStopsPerOffset) break;
              if (stopCount >= maxStops) {
                postMessage({
                  type: 'done',
                  checked,
                  total: work.total,
                  seconds: ((Date.now() - started) / 1000).toFixed(2),
                  limited: true,
                  totalStopsSeen: stopCount
                });
                return;
              }
            }
            if (checked % 1500 === 0) {
              postMessage({
                type: 'progress',
                checked,
                total: work.total,
                seconds: ((Date.now() - started) / 1000).toFixed(1)
              });
            }
          }
        }
      }
    }
  }

  postMessage({
    type: 'done',
    checked,
    total: work.total,
    seconds: ((Date.now() - started) / 1000).toFixed(2)
  });
}

self.onmessage = (event) => {
  const { type, payload } = event.data || {};
  if (type === 'cancel') {
    cancelled = true;
    return;
  }
  if (type !== 'start') return;
  try {
    runSearch(payload);
  } catch (error) {
    postMessage({ type: cancelled ? 'cancelled' : 'error', message: error.message });
  }
};
