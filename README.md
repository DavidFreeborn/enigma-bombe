# Enigma and Bombe

An interactive Enigma and Bombe project for teaching, demonstration, and experimentation.

The repository contains two linked parts:

- `docs/`: a browser-based Enigma and Bombe visualisation, suitable for GitHub Pages.
- `python/`: Python materials, including the Enigma simulator and Bombe-related tutorial code.

The browser app is static. It uses HTML, CSS, and JavaScript, and requires no server-side code.

## Live site

Once GitHub Pages is enabled, the visual tool will be available at:

`https://DavidFreeborn.github.io/enigma-bombe/`

## Repository structure

```text
docs/
  index.html
  app.js
  bombe-worker.js
  styles.css
  README.md

python/
  enigma_bombe.py
  enigma_turing_welchman_bombe.ipynb

README.md
LICENSE
.gitignore
```

## Running the visual tool locally

Open PowerShell inside the `docs/` folder and run:

```powershell
py -m http.server 8131 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:8131
```

Do not open `index.html` directly from the file system. The Bombe search uses a Web Worker, which needs the page to be served over HTTP.

## GitHub Pages

This repository is designed to publish the visual tool from the `docs/` folder.

In GitHub:

1. Open the repository.
2. Go to Settings.
3. Go to Pages.
4. Under Build and deployment, choose Deploy from a branch.
5. Select branch: `main`.
6. Select folder: `/docs`.
7. Click Save.

## License

MIT License. See `LICENSE`.
