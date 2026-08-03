/**
 * Jest stub for `lucide-react-native`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `lucide-react-native` requires `react-native-svg`, whose CommonJS build does
 * `require('react-native')` and destructures `Touchable.Mixin` at module load
 * time. Under the root jest config (`testEnvironment: 'node'`, node_modules
 * left untransformed) that fails in two different ways:
 *
 *   1. No react-native mock in the test  -> react-native/index.js is shipped as
 *      untranspiled Flow, so requiring it throws
 *      "SyntaxError: Cannot use import statement outside a module".
 *   2. A partial react-native mock (e.g. `{ Platform: { OS: 'web' } }`, which
 *      several suites install) -> "Cannot destructure property 'Mixin' of
 *      '_reactNative.Touchable' as it is undefined".
 *
 * Any module that pulls in `lib/fileUtils.ts` inherits that failure, because
 * fileUtils imports icon components at module scope. The icons themselves are
 * pure presentation and are never asserted on by the logic suites, so mapping
 * the package to inert placeholder components keeps the import graph loadable
 * without faking any behaviour under test.
 *
 * Tests that need to assert on icons still override this with their own
 * `jest.mock('lucide-react-native', ...)` factory (an explicit factory mock
 * takes precedence over moduleNameMapper).
 */

const React = require('react');

const iconCache = new Map();

function createIconStub(name) {
  if (!iconCache.has(name)) {
    const Icon = (props) => React.createElement('lucide-icon-stub', { ...props, name });
    Icon.displayName = name;
    iconCache.set(name, Icon);
  }
  return iconCache.get(name);
}

// Keys that must not be answered with a component: module-interop and
// promise-detection probes performed by jest / babel / TypeScript helpers.
const PASSTHROUGH_KEYS = new Set(['then', 'catch', 'finally', 'default', 'prototype']);

module.exports = new Proxy(
  {
    __esModule: true,
    // `createLucideIcon` is the package's factory export; a few call sites use
    // it directly to build custom icons (e.g. with @lucide/lab icon nodes).
    createLucideIcon: (name) => createIconStub(String(name ?? 'CustomIcon')),
    Icon: createIconStub('Icon'),
  },
  {
    get(target, prop) {
      if (prop in target) {
        return target[prop];
      }
      if (typeof prop !== 'string' || PASSTHROUGH_KEYS.has(prop)) {
        return undefined;
      }
      return createIconStub(prop);
    },
    has(target, prop) {
      if (prop in target) return true;
      return typeof prop === 'string' && !PASSTHROUGH_KEYS.has(prop);
    },
  },
);
