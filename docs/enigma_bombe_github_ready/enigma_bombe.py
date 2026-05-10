"""Enigma and Turing-Welchman Bombe simulation.

This module contains two pieces:

1. A historically faithful three-rotor Enigma I / M3 style simulator.
2. A software simulation of the central Turing-Welchman Bombe mechanism:
   crib menus, Enigma scrambler links, Welchman's diagonal board, current
   propagation, stops, and a checking stage.

The Bombe model is logical/electrical rather than mechanical: it does not
simulate motor speed, brush wear, relay timing, or the physical inertia of the
machine. It does simulate the cryptanalytic circuit that matters for finding
stops.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from itertools import combinations, product
from typing import Iterable

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
NODE_COUNT = 26 * 26


def char_to_int(ch: str) -> int:
    """Convert a capital letter A-Z to an integer 0-25."""
    return ord(ch.upper()) - ord("A")


def int_to_char(i: int) -> str:
    """Convert an integer 0-25 to a capital letter A-Z."""
    return chr((i % 26) + ord("A"))


def sanitize(text: str) -> str:
    """Keep only alphabetic letters and convert to uppercase."""
    return "".join(ch for ch in text.upper() if ch.isalpha())


def all_positions() -> list[str]:
    """Return all 26^3 three-rotor window positions, from AAA to ZZZ."""
    return ["".join(p) for p in product(ALPHABET, repeat=3)]


# ---------------------------------------------------------------------------
# Historical Enigma wiring tables
# ---------------------------------------------------------------------------

# Each rotor wiring says where input A, B, C, ... goes when the rotor is at A
# and the ring setting is A. The notch letters are the window letters at which
# the rotor causes the rotor to its left to step.
ROTOR_SPECS: dict[str, tuple[str, str]] = {
    "I": ("EKMFLGDQVZNTOWYHXUSPAIBRCJ", "Q"),
    "II": ("AJDKSIRUXBLHWTMCQGZNPYFVOE", "E"),
    "III": ("BDFHJLCPRTXVZNYEIWGAKMUSQO", "V"),
    "IV": ("ESOVPZJAYQUIRHXLNFTGKDCMWB", "J"),
    "V": ("VZBRGITYUPSDNHLXAWMJQOFECK", "Z"),
    "VI": ("JPGVOUMFYQBENHZRDKASXLICTW", "ZM"),
    "VII": ("NZJHGRCXMYSWBOUFAIVLPEKQDT", "ZM"),
    "VIII": ("FKQHTLXOCBJSPDZRAMEWNIUYGV", "ZM"),
}

# Reflector B was the common Wehrmacht/Luftwaffe reflector. C is also included.
REFLECTORS: dict[str, str] = {
    "B": "YRUHQSLDPXNGOKMIEBFZCWVJAT",
    "C": "FVPJIAOYEDRZXWGCTKUQSBNMHL",
}


@dataclass
class Rotor:
    """A single Enigma rotor.

    Physical correspondence:
    - ``wiring`` is the internal bundle of 26 wires inside the rotor.
    - ``position`` is the visible letter in the machine window.
    - ``ring_setting`` is the alphabet ring setting, historically Ringstellung.
    - ``notches`` are the mechanical turnover notches on the alphabet ring.
    """

    name: str
    ring_setting: str = "A"
    position: str = "A"

    def __post_init__(self) -> None:
        if self.name not in ROTOR_SPECS:
            raise ValueError(f"Unknown rotor: {self.name}")

        wiring_str, notch_str = ROTOR_SPECS[self.name]
        self.wiring = [char_to_int(ch) for ch in wiring_str]

        # The return path through a rotor uses the inverse wiring.
        self.inverse_wiring = [0] * 26
        for input_contact, output_contact in enumerate(self.wiring):
            self.inverse_wiring[output_contact] = input_contact

        self.notches = {char_to_int(ch) for ch in notch_str}
        self.ring = char_to_int(self.ring_setting)
        self.pos = char_to_int(self.position)

    def at_notch(self) -> bool:
        """Return True if the visible window letter is at a turnover notch."""
        return self.pos in self.notches

    def step(self) -> None:
        """Advance this rotor by one position."""
        self.pos = (self.pos + 1) % 26

    def visible_position(self) -> str:
        """Return the visible window letter."""
        return int_to_char(self.pos)

    def encode_forward(self, c: int) -> int:
        """Pass a signal through the rotor from keyboard side to reflector side."""
        shifted = (c + self.pos - self.ring) % 26
        wired = self.wiring[shifted]
        return (wired - self.pos + self.ring) % 26

    def encode_backward(self, c: int) -> int:
        """Pass a signal through the rotor from reflector side back to keyboard side."""
        shifted = (c + self.pos - self.ring) % 26
        wired = self.inverse_wiring[shifted]
        return (wired - self.pos + self.ring) % 26


class Plugboard:
    """The Enigma plugboard, historically the Steckerbrett.

    A cable joins two letters, so the mapping is a pairwise swap. If A is
    plugged to V, then A maps to V and V maps to A. Letters without a cable pass
    through unchanged.
    """

    def __init__(self, pairs: str = "") -> None:
        self.mapping = list(range(26))
        used: set[int] = set()

        for pair in pairs.upper().split():
            if len(pair) != 2 or not pair.isalpha():
                raise ValueError(f"Invalid plugboard pair: {pair}")

            a, b = char_to_int(pair[0]), char_to_int(pair[1])
            if a == b:
                raise ValueError(f"A plugboard cable cannot connect a letter to itself: {pair}")
            if a in used or b in used:
                raise ValueError(f"A plugboard letter appears in more than one pair: {pair}")

            used.add(a)
            used.add(b)
            self.mapping[a] = b
            self.mapping[b] = a

    def encode(self, c: int) -> int:
        """Apply the plugboard swap for one letter index."""
        return self.mapping[c]


class EnigmaMachine:
    """A three-rotor Enigma I / M3 style machine.

    Rotor order is supplied left-to-right. For example, ``("I", "II", "III")``
    means I is the slow left rotor, II is the middle rotor, and III is the fast
    right rotor.
    """

    def __init__(
        self,
        rotors: tuple[str, str, str] = ("I", "II", "III"),
        reflector: str = "B",
        ring_settings: str = "AAA",
        positions: str = "AAA",
        plugboard_pairs: str = "",
    ) -> None:
        if len(rotors) != 3:
            raise ValueError("This simulator expects exactly three rotors.")
        if len(ring_settings) != 3:
            raise ValueError("ring_settings must have three letters, e.g. 'AAA'.")
        if len(positions) != 3:
            raise ValueError("positions must have three letters, e.g. 'AAA'.")
        if reflector not in REFLECTORS:
            raise ValueError(f"Unknown reflector: {reflector}")

        self.rotor_names = rotors
        self.reflector_name = reflector
        self.ring_settings = ring_settings
        self.rotors = [
            Rotor(rotors[0], ring_settings[0], positions[0]),
            Rotor(rotors[1], ring_settings[1], positions[1]),
            Rotor(rotors[2], ring_settings[2], positions[2]),
        ]
        self.reflector = [char_to_int(ch) for ch in REFLECTORS[reflector]]
        self.plugboard = Plugboard(plugboard_pairs)

    def rotor_positions(self) -> str:
        """Return the current visible rotor positions, left-to-right."""
        return "".join(rotor.visible_position() for rotor in self.rotors)

    def step_rotors(self) -> None:
        """Step the rotors before a keypress.

        This models the Enigma pawl-and-ratchet mechanism, including the middle
        rotor double-step. The right rotor steps every time. The middle rotor
        steps when the right rotor is at its notch, and also when the middle
        rotor itself is at its notch. The left rotor steps when the middle rotor
        is at its notch.
        """
        left, middle, right = self.rotors
        middle_at_notch = middle.at_notch()
        right_at_notch = right.at_notch()

        if middle_at_notch:
            left.step()
        if right_at_notch or middle_at_notch:
            middle.step()
        right.step()

    def core_encode_int(self, c: int) -> int:
        """Encode through rotors and reflector only, without plugboard or stepping."""
        for rotor in reversed(self.rotors):
            c = rotor.encode_forward(c)
        c = self.reflector[c]
        for rotor in self.rotors:
            c = rotor.encode_backward(c)
        return c

    def core_permutation(self) -> tuple[int, ...]:
        """Return the internal rotor-reflector permutation at the current position."""
        return tuple(self.core_encode_int(i) for i in range(26))

    def encode_char(self, ch: str, preserve_nonalpha: bool = False) -> str:
        """Encode one character.

        Historically, the military Enigma had no space key. If
        ``preserve_nonalpha`` is False, spaces and punctuation are removed. If it
        is True, they are returned unchanged and do not step the rotors.
        """
        if not ch.isalpha():
            return ch if preserve_nonalpha else ""

        self.step_rotors()
        c = char_to_int(ch)
        c = self.plugboard.encode(c)
        c = self.core_encode_int(c)
        c = self.plugboard.encode(c)
        return int_to_char(c)

    def encode(
        self,
        text: str,
        preserve_nonalpha: bool = False,
        group_output: bool = False,
        group_size: int = 5,
    ) -> str:
        """Encode or decode a full message.

        Enigma is reciprocal: encrypting and decrypting use the same operation,
        provided the machine is reset to the same starting settings.
        """
        out = "".join(self.encode_char(ch, preserve_nonalpha) for ch in text)
        if group_output:
            clean = sanitize(out)
            return " ".join(clean[i : i + group_size] for i in range(0, len(clean), group_size))
        return out


# ---------------------------------------------------------------------------
# Bombe menu and circuit model
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MenuLink:
    """One Bombe menu link.

    Physical correspondence: one 26-way cable between two letter registers on
    the Bombe gate, passing through one Enigma-equivalent scrambler. The
    ``message_index`` gives the crib position, so the scrambler is set at the
    corresponding drum offset.
    """

    plain: int
    cipher: int
    message_index: int


class BombeMenu:
    """A Bombe menu built from a crib and a ciphertext segment.

    A crib is a guessed plaintext fragment. For each crib position, we connect
    the plaintext letter to the corresponding ciphertext letter through an
    Enigma-equivalent scrambler. The resulting graph is the menu.
    """

    def __init__(self, crib: str, ciphertext: str, offset: int = 0) -> None:
        self.crib = sanitize(crib)
        self.ciphertext = sanitize(ciphertext)
        self.offset = offset

        if len(self.crib) == 0:
            raise ValueError("The crib must contain at least one letter.")
        if offset < 0:
            raise ValueError("offset must be non-negative.")
        if offset + len(self.crib) > len(self.ciphertext):
            raise ValueError("The crib extends beyond the ciphertext.")

        self.cipher_slice = self.ciphertext[offset : offset + len(self.crib)]
        self.links: list[MenuLink] = []

        for i, (p, c) in enumerate(zip(self.crib, self.cipher_slice)):
            # Enigma never encrypts a letter as itself. Bletchley called such a
            # crib placement a crash, and rejected it before using the Bombe.
            if p == c:
                raise ValueError(
                    f"Crib crash at crib index {i}: {p} aligns with itself."
                )
            self.links.append(MenuLink(char_to_int(p), char_to_int(c), offset + i))

    @property
    def letters(self) -> list[int]:
        """Letters that appear as nodes in the menu graph."""
        letters: set[int] = set()
        for link in self.links:
            letters.add(link.plain)
            letters.add(link.cipher)
        return sorted(letters)

    def degree_counter(self) -> Counter[int]:
        """Count how often each letter occurs in the menu."""
        degrees: Counter[int] = Counter()
        for link in self.links:
            degrees[link.plain] += 1
            degrees[link.cipher] += 1
        return degrees

    def choose_test_letter(self) -> str:
        """Choose a useful test letter, usually the highest-degree menu letter."""
        letter, _ = self.degree_counter().most_common(1)[0]
        return int_to_char(letter)

    def cycle_count(self) -> int:
        """Return the independent cycle count of the menu graph.

        Menus with more cycles usually reject wrong rotor positions more
        strongly, producing fewer false stops.
        """
        parent = {letter: letter for letter in self.letters}

        def find(x: int) -> int:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a: int, b: int) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        for link in self.links:
            union(link.plain, link.cipher)

        components = len({find(letter) for letter in self.letters})
        return len(self.links) - len(self.letters) + components

    def summary(self) -> str:
        """Return a human-readable description of the menu."""
        letters = "".join(int_to_char(i) for i in self.letters)
        test = self.choose_test_letter()
        return (
            f"Menu length: {len(self.links)} links\n"
            f"Menu letters: {letters}\n"
            f"Independent cycles: {self.cycle_count()}\n"
            f"Suggested test letter: {test}"
        )


class DisjointSet:
    """Small union-find structure used to compute circuit connectivity.

    Physical correspondence: if two contacts are joined by wires, current can
    pass between them. In software, contacts reachable by current are in the
    same connected component.
    """

    def __init__(self, parent: list[int] | None = None, rank: list[int] | None = None) -> None:
        self.parent = list(range(NODE_COUNT)) if parent is None else parent[:]
        self.rank = [0] * NODE_COUNT if rank is None else rank[:]

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1


def contact(letter: int, possible_stecker: int) -> int:
    """Return the circuit contact for 'letter is steckered to possible_stecker'."""
    return 26 * letter + possible_stecker


def split_contact(node: int) -> tuple[int, int]:
    """Return (letter, possible_stecker) for a circuit contact."""
    return divmod(node, 26)


def make_diagonal_board_base() -> tuple[list[int], list[int]]:
    """Return base connectivity for Welchman's diagonal board.

    The diagonal board implements plugboard symmetry. If A may be steckered to
    V, then V may be steckered to A. In contact notation, it wires (A,V) to
    (V,A) for every pair of letters.
    """
    dsu = DisjointSet()
    for a in range(26):
        for b in range(a + 1, 26):
            dsu.union(contact(a, b), contact(b, a))
    return dsu.parent, dsu.rank


DIAGONAL_PARENT, DIAGONAL_RANK = make_diagonal_board_base()


def advance_window_position(
    positions: str,
    rotors: tuple[str, str, str],
    steps: int,
) -> str:
    """Advance visible rotor positions by a number of Enigma keypresses."""
    machine = EnigmaMachine(rotors=rotors, positions=positions)
    for _ in range(steps):
        machine.step_rotors()
    return machine.rotor_positions()


def internal_permutation_at(
    rotors: tuple[str, str, str],
    reflector: str,
    ring_settings: str,
    positions: str,
) -> tuple[int, ...]:
    """Return the rotor-reflector permutation for a fixed drum position."""
    machine = EnigmaMachine(
        rotors=rotors,
        reflector=reflector,
        ring_settings=ring_settings,
        positions=positions,
        plugboard_pairs="",
    )
    return machine.core_permutation()


def core_permutations_for_menu(
    menu: BombeMenu,
    rotors: tuple[str, str, str],
    reflector: str,
    ring_settings: str,
    positions: str,
) -> list[tuple[int, ...]]:
    """Compute the Enigma-equivalent permutation for each menu link.

    The first encrypted letter is processed after one rotor step. Therefore a
    link at message index i uses the internal permutation after i + 1 keypresses.
    """
    cache: dict[str, tuple[int, ...]] = {}
    perms: list[tuple[int, ...]] = []

    for link in menu.links:
        link_position = advance_window_position(positions, rotors, link.message_index + 1)
        if link_position not in cache:
            cache[link_position] = internal_permutation_at(
                rotors, reflector, ring_settings, link_position
            )
        perms.append(cache[link_position])

    return perms


class BombeCircuit:
    """The wired electrical circuit for one rotor position.

    Physical correspondence:
    - 26 registers of 26 contacts represent possible plugboard hypotheses.
    - Menu links are 26-way cables through Enigma-equivalent scramblers.
    - The diagonal board permanently joins symmetric plugboard hypotheses.
    - A stop occurs when at least one test hypothesis survives without forcing
      an impossible plugboard assignment.
    """

    def __init__(
        self,
        menu: BombeMenu,
        core_permutations: list[tuple[int, ...]],
        use_diagonal_board: bool = True,
    ) -> None:
        if len(menu.links) != len(core_permutations):
            raise ValueError("Each menu link needs one internal permutation.")

        if use_diagonal_board:
            self.dsu = DisjointSet(DIAGONAL_PARENT, DIAGONAL_RANK)
        else:
            self.dsu = DisjointSet()

        for link, perm in zip(menu.links, core_permutations):
            # For each possible stecker value x for the plaintext letter, the
            # scrambler says the ciphertext letter must be steckered to perm[x].
            for x in range(26):
                self.dsu.union(contact(link.plain, x), contact(link.cipher, perm[x]))

        self._bad_components: set[int] | None = None

    def bad_components(self) -> set[int]:
        """Components that imply a contradiction.

        A component is bad if it contains two different possible stecker values
        for the same letter. A letter cannot be plugged to two letters at once.
        """
        if self._bad_components is not None:
            return self._bad_components

        row_masks: dict[int, int] = {}
        bad: set[int] = set()

        for node in range(NODE_COUNT):
            letter, _ = split_contact(node)
            root = self.dsu.find(node)
            bit = 1 << letter
            old_mask = row_masks.get(root, 0)
            if old_mask & bit:
                bad.add(root)
            row_masks[root] = old_mask | bit

        self._bad_components = bad
        return bad

    def component_mapping(self, root: int) -> list[int]:
        """Return the partial plugboard mapping implied by one component."""
        mapping = [-1] * 26
        for node in range(NODE_COUNT):
            if self.dsu.find(node) == root:
                letter, value = split_contact(node)
                if mapping[letter] == -1:
                    mapping[letter] = value
                elif mapping[letter] != value:
                    # This should only happen in a bad component.
                    return [-2] * 26
        return mapping

    def live_hypotheses(self, test_letter: str) -> list["LiveHypothesis"]:
        """Return surviving stecker hypotheses for the chosen test letter."""
        t = char_to_int(test_letter)
        bad = self.bad_components()
        live: list[LiveHypothesis] = []

        for value in range(26):
            root = self.dsu.find(contact(t, value))
            if root not in bad:
                live.append(
                    LiveHypothesis(
                        test_letter=test_letter,
                        stecker_value=int_to_char(value),
                        partial_mapping=self.component_mapping(root),
                    )
                )
        return live


@dataclass
class LiveHypothesis:
    """One surviving Bombe hypothesis at a stop."""

    test_letter: str
    stecker_value: str
    partial_mapping: list[int]

    def pairs_fixed_unknown(self) -> tuple[list[str], list[str], list[str]]:
        return format_partial_plugboard(self.partial_mapping)


@dataclass
class BombeStop:
    """A Bombe stop: one rotor state with one or more surviving hypotheses."""

    offset: int
    rotors: tuple[str, str, str]
    reflector: str
    ring_settings: str
    positions: str
    test_letter: str
    hypotheses: list[LiveHypothesis]

    def best_hypothesis(self) -> LiveHypothesis:
        """Choose the hypothesis that determines the most plugboard letters."""
        return max(
            self.hypotheses,
            key=lambda h: sum(1 for value in h.partial_mapping if value >= 0),
        )

    def to_dict(self) -> dict:
        """Return a compact dictionary version of the stop."""
        h = self.best_hypothesis()
        pairs, fixed, unknown = h.pairs_fixed_unknown()
        return {
            "offset": self.offset,
            "rotors": self.rotors,
            "reflector": self.reflector,
            "ring_settings": self.ring_settings,
            "positions": self.positions,
            "test_letter": self.test_letter,
            "live_test_values": [hyp.stecker_value for hyp in self.hypotheses],
            "best_test_value": h.stecker_value,
            "partial_plugboard": pairs,
            "confirmed_unplugged": fixed,
            "undetermined": unknown,
        }


class TuringWelchmanBombe:
    """A software model of the Turing-Welchman Bombe's cryptanalytic circuit.

    For each candidate rotor state, the Bombe wires a menu of Enigma-equivalent
    scramblers and the diagonal board, then checks whether the circuit forces a
    contradiction. Non-contradictory states are returned as stops.
    """

    def __init__(
        self,
        ciphertext: str,
        crib: str,
        offset: int = 0,
        test_letter: str | None = None,
        use_diagonal_board: bool = True,
    ) -> None:
        self.menu = BombeMenu(crib=crib, ciphertext=ciphertext, offset=offset)
        self.test_letter = test_letter or self.menu.choose_test_letter()
        self.use_diagonal_board = use_diagonal_board

    def test_state(
        self,
        rotors: tuple[str, str, str],
        reflector: str,
        ring_settings: str,
        positions: str,
    ) -> BombeStop | None:
        """Test one candidate drum position and return a stop if it survives."""
        perms = core_permutations_for_menu(
            self.menu, rotors, reflector, ring_settings, positions
        )
        circuit = BombeCircuit(
            self.menu,
            perms,
            use_diagonal_board=self.use_diagonal_board,
        )
        hypotheses = circuit.live_hypotheses(self.test_letter)

        if not hypotheses:
            return None

        return BombeStop(
            offset=self.menu.offset,
            rotors=rotors,
            reflector=reflector,
            ring_settings=ring_settings,
            positions=positions,
            test_letter=self.test_letter,
            hypotheses=hypotheses,
        )

    def run(
        self,
        rotor_orders: Iterable[tuple[str, str, str]],
        reflectors: Iterable[str],
        ring_settings: Iterable[str],
        positions: Iterable[str] | None = None,
        max_stops: int = 10,
    ) -> list[BombeStop]:
        """Run the Bombe over the requested search space.

        ``positions=None`` means all 17,576 three-rotor window positions. That
        is faithful to the machine's purpose but may be slow in pure Python.
        """
        positions_to_try = all_positions() if positions is None else list(positions)
        stops: list[BombeStop] = []

        for rotors in rotor_orders:
            for reflector in reflectors:
                for rings in ring_settings:
                    for pos in positions_to_try:
                        stop = self.test_state(rotors, reflector, rings, pos)
                        if stop is not None:
                            stops.append(stop)
                            if len(stops) >= max_stops:
                                return stops
        return stops


# ---------------------------------------------------------------------------
# Checking and decoding stops
# ---------------------------------------------------------------------------

def format_partial_plugboard(mapping: list[int]) -> tuple[list[str], list[str], list[str]]:
    """Convert a partial numeric plugboard mapping into readable lists."""
    pairs: list[str] = []
    fixed: list[str] = []
    unknown: list[str] = []

    for i, value in enumerate(mapping):
        if value == -1:
            unknown.append(int_to_char(i))
        elif value == i:
            fixed.append(int_to_char(i))
        elif 0 <= value < 26 and i < value:
            pairs.append(int_to_char(i) + int_to_char(value))
    return pairs, fixed, unknown


def plugboard_string(pairs: list[str]) -> str:
    """Convert ['AV', 'BS'] into the string format used by EnigmaMachine."""
    return " ".join(pairs)


def decode_with_settings(
    ciphertext: str,
    rotors: tuple[str, str, str],
    reflector: str,
    ring_settings: str,
    positions: str,
    plugboard_pairs: list[str],
) -> str:
    """Decode ciphertext by running it through a reset Enigma machine."""
    machine = EnigmaMachine(
        rotors=rotors,
        reflector=reflector,
        ring_settings=ring_settings,
        positions=positions,
        plugboard_pairs=plugboard_string(plugboard_pairs),
    )
    return machine.encode(ciphertext, preserve_nonalpha=False)


def decode_with_bombe_stop(
    ciphertext: str,
    stop: BombeStop,
    plugboard_pairs: list[str] | None = None,
) -> str:
    """Decode using a Bombe stop and either supplied or inferred plugboard pairs."""
    if plugboard_pairs is None:
        plugboard_pairs, _, _ = stop.best_hypothesis().pairs_fixed_unknown()

    return decode_with_settings(
        ciphertext=ciphertext,
        rotors=stop.rotors,
        reflector=stop.reflector,
        ring_settings=stop.ring_settings,
        positions=stop.positions,
        plugboard_pairs=plugboard_pairs,
    )


COMMON_ENGLISH_WORDS = [
    "THE", "AND", "THAT", "HAVE", "FOR", "NOT", "WITH", "YOU", "THIS",
    "FROM", "ATTACK", "DAWN", "REPORT", "WEATHER", "MESSAGE", "POSITION",
    "ENEMY", "TROOPS", "SUPPLY", "BEGIN", "FOLLOWS",
]


def english_score(text: str, extra_words: list[str] | None = None) -> int:
    """Crude score used to rank checked decryptions."""
    clean = sanitize(text)
    words = COMMON_ENGLISH_WORDS[:]
    if extra_words:
        words.extend(sanitize(word) for word in extra_words)
    return sum(clean.count(word) * len(word) for word in words)


def generate_pair_completions(
    unknown_letters: list[str],
    pairs_needed: int,
    max_completions: int = 10_000,
) -> list[list[str]]:
    """Generate possible extra plugboard pairs among unknown letters."""
    unknown_letters = sorted(unknown_letters)
    completions: list[list[str]] = []

    def rec(available: list[str], needed: int, current: list[str]) -> None:
        if len(completions) >= max_completions:
            return
        if needed == 0:
            completions.append(current[:])
            return
        if len(available) < 2 * needed:
            return

        first = available[0]
        rest = available[1:]

        # Pair the first available unknown with one of the others.
        for i, second in enumerate(rest):
            remaining = rest[:i] + rest[i + 1 :]
            rec(remaining, needed - 1, current + [first + second])

        # Or leave it unplugged, if enough letters remain for the needed pairs.
        if len(rest) >= 2 * needed:
            rec(rest, needed, current)

    rec(unknown_letters, pairs_needed, [])
    return completions


def check_stop_and_decode(
    ciphertext: str,
    stop: BombeStop,
    total_plugboard_pairs: int = 10,
    max_completions_per_hypothesis: int = 10_000,
    top_n: int = 10,
    extra_words: list[str] | None = None,
) -> list[dict]:
    """Check a Bombe stop by completing its plugboard and ranking decryptions.

    Historically, a Bombe stop still had to be checked. This function plays that
    checking role: it tries completions of the plugboard pairs not forced by the
    stop, decodes the message, and sorts the results by a simple plaintext score.
    """
    candidates: list[dict] = []

    for hypothesis in stop.hypotheses:
        known_pairs, confirmed_unplugged, unknown = hypothesis.pairs_fixed_unknown()
        pairs_needed = total_plugboard_pairs - len(known_pairs)

        if pairs_needed < 0:
            continue

        completions = generate_pair_completions(
            unknown_letters=unknown,
            pairs_needed=pairs_needed,
            max_completions=max_completions_per_hypothesis,
        )

        for completion in completions:
            full_pairs = known_pairs + completion
            plaintext = decode_with_bombe_stop(ciphertext, stop, full_pairs)
            candidates.append(
                {
                    "score": english_score(plaintext, extra_words),
                    "plaintext": plaintext,
                    "plugboard_pairs": full_pairs,
                    "test_letter": hypothesis.test_letter,
                    "test_value": hypothesis.stecker_value,
                    "confirmed_unplugged": confirmed_unplugged,
                }
            )

    candidates.sort(key=lambda item: item["score"], reverse=True)
    return candidates[:top_n]


# ---------------------------------------------------------------------------
# Minimal self-tests
# ---------------------------------------------------------------------------

def run_self_tests() -> None:
    """Run lightweight checks for the Enigma and Bombe code."""
    machine = EnigmaMachine(
        rotors=("I", "II", "III"),
        reflector="B",
        ring_settings="AAA",
        positions="AAA",
        plugboard_pairs="",
    )
    assert machine.encode("AAAAA") == "BDZGO"

    settings = {
        "rotors": ("I", "II", "III"),
        "reflector": "B",
        "ring_settings": "AAA",
        "positions": "MCK",
        "plugboard_pairs": "AV BS CG DL FU HZ IN KM OW RX",
    }
    plaintext = "WEATHERREPORTFOLLOWSBEGINATTACKATDAWN"
    ciphertext = EnigmaMachine(**settings).encode(plaintext)

    bombe = TuringWelchmanBombe(ciphertext, plaintext[:30], offset=0)
    stop = bombe.test_state(
        rotors=settings["rotors"],
        reflector=settings["reflector"],
        ring_settings=settings["ring_settings"],
        positions=settings["positions"],
    )
    assert stop is not None
    checked = check_stop_and_decode(
        ciphertext,
        stop,
        total_plugboard_pairs=10,
        top_n=1,
        extra_words=["WEATHER", "REPORT", "FOLLOWS", "BEGIN", "ATTACK", "DAWN"],
    )
    assert checked[0]["plaintext"] == plaintext


if __name__ == "__main__":
    run_self_tests()
    print("Self-tests passed.")
