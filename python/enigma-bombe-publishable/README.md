# Enigma + Bombe

A static browser app for exploring a three-rotor Enigma I / M3 machine and a Turing-Welchman-style Bombe menu test.

The app is designed for teaching, demonstration, and self-guided exploration. It runs entirely in the browser, uses no external libraries, sends no data anywhere, and can be hosted directly on GitHub Pages.

## Features

- Interactive Enigma I / M3 simulator with rotors I to V, reflectors B and C, ring settings, start windows, and a physical plugboard interface.
- One-letter path visualisation showing the signal through the plugboard, rotors, reflector, return path, and output bulb.
- Bombe-style menu construction from a crib and ciphertext.
- Plugboard-style menu visualisation, where menu lines are crib-derived test links rather than final plugboard cables.
- Bombe search running in a Web Worker so the page remains responsive.
- Explicit search modes with live progress, search speed, and estimated time remaining.
- Candidate stops, recovered plugboard consequences, selected-stop decoding, and completions across listed stops.

## Repository contents

| File | Purpose |
| --- | --- |
| `index.html` | Main app page. |
| `styles.css` | Layout and visual design. |
| `app.js` | Enigma simulator, UI logic, plugboard drawing, menu drawing, and decoding helpers. |
| `bombe-worker.js` | Bombe search logic running in a Web Worker. |
| `serve.py` | Small local development server. |
| `start-local-server.bat` | Windows helper for local testing. |
| `README.md` | Project documentation. |
| `LICENSE` | Licence information. |

## Run locally on Windows

Do not double-click `index.html`. The Bombe search uses a Web Worker, and browsers block workers from `file:///` pages.

The simplest method is:

1. Unzip the repository folder.
2. Open the folder containing `index.html`.
3. Double-click `start-local-server.bat`.
4. Your browser should open at `http://127.0.0.1:8131`.
5. Leave the terminal window open while using the app.
6. To stop the server, close the terminal window or press `Ctrl+C` in it.

If the browser does not open, go to:

```text
http://127.0.0.1:8131
```

## Run locally with Python

Open a terminal in the folder containing `index.html`, then run:

```bash
python serve.py
```

or:

```bash
python3 serve.py
```

Then open:

```text
http://127.0.0.1:8131
```

## Host on GitHub Pages

1. Create a GitHub repository.
2. Upload the files in this folder to the root of the repository.
3. In GitHub, go to **Settings > Pages**.
4. Set the source to deploy from the main branch.
5. Open the GitHub Pages URL after deployment completes.

No build step is required.

## Search modes

The Bombe tab has explicit search modes because a fully exhaustive browser search can become very large.

### Standard search, fixed ring setting

This is the default. It searches:

- all 60 rotor orders;
- both reflectors;
- all starting window positions;
- every possible crib placement;
- one fixed ring setting, default `AAA`.

This is the practical browser default and is usually the best mode for demonstrations.

### Exhaustive ring search

This also tries all 17,576 ring settings. It is 17,576 times larger than the standard search and may take a long time in a browser. The app shows live progress, speed, and estimated time remaining.

### Chosen setup modes

These modes restrict the search to a chosen rotor order and reflector. They are useful for focused experiments, debugging, and explaining how a specific Bombe setup behaves.

## Cribs, placements, and stops

A **crib** is a guessed part of the original plaintext, such as `WEATHERREPORT`.

A **crib placement** is a possible position where that guess could sit under the ciphertext. For example, position `0` means the crib begins at the first ciphertext letter; position `5` means five ciphertext letters come before it.

A **stop** is a candidate machine setting that survives the Bombe contradiction test. It is not automatically the answer. Short cribs can produce many false stops because they place only weak constraints on the machine. Longer cribs, especially those that create closed circuits in the menu, are more useful.

## Accuracy and scope

The Enigma simulator models a three-rotor Enigma I / M3 style machine with:

- rotors I to V;
- reflectors B and C;
- ring settings;
- start window positions;
- plugboard wiring;
- pre-keypress rotor stepping, including double-stepping.

It does not model every Enigma variant. In particular, it does not include the four-rotor naval M4, thin reflectors, Beta/Gamma rotors, rotors VI to VIII, or the full range of historical message procedures.

The Bombe component is a browser-based model of the menu and diagonal-board contradiction test. It is designed to make the cryptanalytic logic visible. It is not an electromechanical or circuit-level simulation of an actual British Bombe.

## Development notes

This project is deliberately dependency-free. To modify it, edit the HTML, CSS, and JavaScript files directly. A useful development loop is:

```bash
python serve.py
```

then reload the browser.

For quick syntax checks:

```bash
node --check app.js
node --check bombe-worker.js
```

## Licence

This project is released under the MIT Licence. See `LICENSE`.
