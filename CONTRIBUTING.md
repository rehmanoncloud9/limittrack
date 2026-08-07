# Contributing to LimitTrack

Thanks for considering a contribution — bug reports, feature ideas, and PRs are all welcome.

## Development setup

```bash
git clone https://github.com/rehmanoncloud9/limittrack.git
cd limittrack
npm install
npm start
```

The app runs straight from source — no build/bundle step during development.

## Where things live

| File | What it does |
|---|---|
| `main.js` | Electron main process — window, system tray, local JSON storage |
| `preload.js` | Secure bridge exposing storage to the renderer |
| `index.html` | App shell (loads Tailwind via CDN) |
| `renderer.js` | All UI state, rendering, and event handling (vanilla JS) |
| `build/icon.png` | Source icon used to generate platform installers |

## Making a change

1. Fork the repo and create a branch off `main`.
2. Make your change and test it with `npm start`.
3. Open a PR with a clear description of what changed and why.

## Reporting bugs

Open an issue with steps to reproduce, what you expected, and what happened instead. Screenshots help.

## Suggesting features

Open an issue describing the problem you're hitting and the workflow you'd want — happy to discuss the best way to fit it in before you write code.
