# Contributing to LimitTrack

Thanks for considering a contribution. Bug reports, feature ideas, and PRs are all welcome.

## Development setup

```bash
git clone https://github.com/rehmanoncloud9/limittrack.git
cd limittrack
npm install
npm start
```

The app runs straight from source, with the compiled stylesheet included. When changing utility classes or theme tokens, run `npm run build:styles`. Run `npm test` for the domain, persistence, client concurrency, and mocked Electron checks (Node.js 20 or newer).

## Where things live

| File | What it does |
|---|---|
| `main.js` | Electron main process: window, system tray, local JSON storage |
| `preload.js` | Secure bridge exposing storage to the renderer |
| `index.html` | App shell, loading bundled scripts and styles |
| `renderer.js` | All UI state, rendering, and event handling (vanilla JS) |
| `domain.js` | Shared validation, legacy migration, availability, and conflict-aware state merging |
| `state-client.js` | Renderer write queue and transaction baselines |
| `store.js` | Atomic local persistence and recovery copies |
| `styles.input.css`, `tailwind.config.js`, `app.css` | Utility generation and bundled output |
| `typography.css`, `assets/fonts/` | Native system typography, optional Inter Variable, and font license |
| `appearance.css`, `ui.css`, `preferences.js` | Shared theme tokens, main layout, and persisted appearance/widget settings |
| `widget.html`, `widget.js` | Floating reset overview and account actions |
| `desktop-visibility.js`, `native/desktop-observer.cs` | Windows desktop activation observer; compiled locally with the system .NET Framework compiler, bundled outside ASAR |
| `scripts/build-native.js` | Builds and smoke-checks the Windows helper before development startup and packaging |
| `test/` | Node tests; Electron APIs are mocked rather than launching the user's app |
| `build/icon.png` | Source icon used to generate platform installers |

## Making a change

1. Fork the repo and create a branch off `main`.
2. Make your change and test it with `npm start`.
3. Open a PR with a clear description of what changed and why.

## Reporting bugs

Open an issue with steps to reproduce, what you expected, and what happened instead. Screenshots help.

## Suggesting features

Open an issue describing the problem you're hitting and the workflow you'd want. Happy to discuss the best way to fit it in before you write code.
