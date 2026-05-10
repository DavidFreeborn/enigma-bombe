# Enigma and Turing-Welchman Bombe

This repository-style bundle contains a self-contained Python notebook and a matching Python module.

## Files

- `enigma_turing_welchman_bombe.ipynb`: annotated notebook with explanations, tests, user input cells, Enigma encryption/decryption, Bombe stops, and decoding from a stop.
- `enigma_bombe.py`: importable Python module containing the same core implementation.

## What is modelled

- Three-rotor Enigma I / M3 style machine.
- Rotors I to VIII.
- Reflectors B and C.
- Ring settings, starting window positions, plugboard pairs, and correct pre-keypress stepping.
- Turing-Welchman Bombe logic: crib menus, Enigma-equivalent scramblers, diagonal-board propagation, stops, and checking.

## What is not modelled

The software simulates the Bombe's cryptanalytic circuit, not its irrelevant mechanical physics. It does not model motor inertia, brush wear, relay timing, or acoustics.

## Quick start

Open the notebook and run cells from top to bottom. The last sections contain easy user-input cells for:

1. running the Enigma machine;
2. running the Bombe;
3. decoding the message from a Bombe stop.

The module can also be tested directly:

```bash
python enigma_bombe.py
```

Expected output:

```text
Self-tests passed.
```
