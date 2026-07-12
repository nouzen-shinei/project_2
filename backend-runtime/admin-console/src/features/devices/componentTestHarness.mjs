// Feature: device-console-migration — shared component-test harness.
//
// The admin console has no configured test runner (see package.json: only
// dev/build/preview). The sibling data-layer tests (task 12.2
// `apiClient.deviceAdmin.test.mjs`, task 13.7 `selection.property.test.mjs`)
// established the convention for this package: author the test in ESM, bundle
// the TypeScript module graph with the repo's esbuild (aliasing
// `@shared/planLimits` and keeping React external so there is a single
// instance), then run it under Node's built-in `node --test` runner.
//
// React COMPONENT tests additionally need a DOM. Rather than pull in a full
// browser test framework, this harness stands up a single jsdom document and
// renders the REAL components two ways:
//   • `staticRender` — `react-dom/server` `renderToStaticMarkup`, for pure
//     prop-driven output (labels, placeholders, gating) with no effects.
//   • `mount` + `flush` — `react-dom/client` `createRoot` wrapped in React's
//     `act`, which runs mount effects (the panels' data fetch) and flushes the
//     async state updates, so lifecycle behaviours (refresh refetch, load-error
//     retention, empty/error states) can be asserted against the real render.
//
// Network is never hit: `installFetch` replaces the global `fetch` that the
// real `apiClient` wrappers call, so the actual client + component code runs
// end to end against deterministic responses (and a rejecting fetch simulates a
// load failure). This keeps the components under test unmodified.
//
// IMPORTANT — evaluation order. `configStore` (zustand `persist`) touches
// `localStorage` at import time, and `react-dom` needs `document` at render
// time, so the DOM globals are installed as a side effect when THIS module is
// evaluated, and every DOM-dependent module (React, react-dom, the store, the
// components) is pulled in via dynamic `import()` from `setup()` — i.e. only
// AFTER the globals exist. Test files therefore import this harness first.

import { JSDOM } from 'jsdom';

// --- DOM globals (installed on import, before any component evaluates) -------

function installDomGlobals() {
  if (globalThis.__deviceConsoleDomInstalled) return;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://console.test/?tab=devices',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  globalThis.window = window;
  globalThis.document = window.document;

  // Copy the DOM constructors/helpers React needs onto the global scope, but
  // only when Node does not already provide them — this avoids clobbering
  // Node's own globals (fetch, setTimeout, URL, queueMicrotask, …).
  const carryOver = Object.getOwnPropertyNames(window);
  for (const key of carryOver) {
    if (key in globalThis) continue;
    try {
      globalThis[key] = window[key];
    } catch {
      /* some props are getters-only; skip */
    }
  }

  // React's `act` requires this flag to run without emitting warnings.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__deviceConsoleDomInstalled = true;
}

installDomGlobals();

// --- fetch mocking -----------------------------------------------------------

/**
 * A minimal Response stand-in shaped exactly the way `apiRequest` consumes it:
 * it reads `.ok`, `.status`, and `await .text()` for JSON responses.
 */
function makeResponse(status, dataObj) {
  const bodyText = JSON.stringify(dataObj ?? null);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return bodyText;
    },
    async blob() {
      return { async text() { return bodyText; } };
    },
  };
}

/**
 * Install a mocked global `fetch`. `handler(path, init)` returns either
 * `{ status, data }` (mapped to a Response) or throws / rejects to simulate a
 * transport failure (which `apiRequest` surfaces as a non-`ApiError` Error).
 * Returns a `{ calls, restore }` control object; `calls` records every request.
 */
export function installFetch(handler) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ url: String(url), path, init });
    const result = await handler(path, init, calls.length); // may throw -> reject
    return makeResponse(result.status, result.data);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

// --- render helpers ----------------------------------------------------------

let ctx = null;

/**
 * Resolve React + react-dom + the config store once, after the DOM globals are
 * in place, and point the apiClient at a concrete base URL with a master key so
 * the real wrappers build well-formed requests against the mocked fetch.
 */
export async function setup() {
  if (ctx) return ctx;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const configStore = await import('../../store/configStore');

  configStore.useConfigStore.getState().setBaseUrl('https://api.device-console.test');
  configStore.useConfigStore.getState().setMasterKey('master-key-under-test');

  const act = React.act;

  /** Render `element` to a static HTML string (no effects, no DOM mutations). */
  function staticRender(element) {
    return renderToStaticMarkup(element);
  }

  /** Advance timers/microtasks inside `act` so pending fetches settle. */
  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /**
   * Mount `element` into a fresh detached container under `document.body`,
   * running mount effects inside `act`. Returns the container plus helpers.
   */
  async function mount(element) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root;
    await act(async () => {
      root = createRoot(container);
      root.render(element);
    });
    await flush();
    return {
      container,
      text: () => container.textContent || '',
      /** Find the first <button> whose text matches `re`. */
      findButton: (re) =>
        Array.from(container.querySelectorAll('button')).find((b) => re.test(b.textContent || '')) ||
        null,
      buttons: () => Array.from(container.querySelectorAll('button')),
      async click(el) {
        await act(async () => {
          el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        await flush();
      },
      unmount() {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  ctx = { React, act, staticRender, mount, flush };
  return ctx;
}
