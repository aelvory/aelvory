/**
 * Theme detection — picks dark vs light from the host environment and
 * keeps it in sync as the user toggles theme without reloading.
 *
 * Detection order:
 *   1. VSCode webview class on `<body>` — `vscode-dark`, `vscode-light`,
 *      `vscode-high-contrast`, `vscode-high-contrast-light`. The host
 *      adds these classes automatically and updates them when the user
 *      switches color theme.
 *   2. `prefers-color-scheme` media query — covers Tauri (the system
 *      OS theme) and plain browser dev mode.
 *
 * Result is mapped to a `.dark` class on `<html>`, which PrimeVue's
 * `darkModeSelector: '.dark'` config (see main.ts) keys off for its
 * Aura dark palette. Our own component CSS can also gate styles via
 * `.dark` if it needs to.
 *
 * High-contrast variants are treated as dark for now; the contrast-
 * boosted Aura preset would be a future enhancement.
 */

type Mode = 'light' | 'dark';

const DARK_CLASS = 'dark';

function readVSCodeMode(): Mode | null {
  if (typeof document === 'undefined') return null;
  const cl = document.body.classList;
  if (cl.contains('vscode-high-contrast') && !cl.contains('vscode-high-contrast-light')) {
    return 'dark';
  }
  if (cl.contains('vscode-high-contrast-light')) return 'light';
  if (cl.contains('vscode-dark')) return 'dark';
  if (cl.contains('vscode-light')) return 'light';
  return null;
}

function readSystemMode(): Mode {
  if (typeof matchMedia === 'undefined') return 'light';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyMode(mode: Mode): void {
  const root = document.documentElement;
  if (mode === 'dark') root.classList.add(DARK_CLASS);
  else root.classList.remove(DARK_CLASS);
  // Expose the mode as a data attribute too so component-level CSS
  // can branch without depending on PrimeVue's class hook directly.
  root.dataset.theme = mode;
}

/**
 * Install global theme tracking. Idempotent — calling more than once
 * is a no-op (we install one MutationObserver and one matchMedia
 * listener, both global, both kept alive for the page's lifetime).
 *
 * Returns a teardown function for symmetry with hot-reload scenarios;
 * we don't actually call it in production.
 */
export function installThemeTracker(): () => void {
  if (typeof document === 'undefined') return () => {};

  const w = window as unknown as { __aelvoryThemeInstalled?: boolean };
  if (w.__aelvoryThemeInstalled) return () => {};
  w.__aelvoryThemeInstalled = true;

  const recompute = () => {
    const mode = readVSCodeMode() ?? readSystemMode();
    applyMode(mode);
  };

  recompute();

  // VSCode swaps the body class set when the user changes theme.
  // Watching just `body[class]` is cheap and avoids subtree noise.
  const observer = new MutationObserver(recompute);
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  // Tauri / browser path: react to OS-level theme changes. The VSCode
  // body class takes precedence inside `recompute`, so this listener
  // is harmless in the VSCode build (the class always wins).
  let mql: MediaQueryList | null = null;
  if (typeof matchMedia !== 'undefined') {
    mql = matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', recompute);
  }

  return () => {
    observer.disconnect();
    mql?.removeEventListener('change', recompute);
    delete w.__aelvoryThemeInstalled;
  };
}
