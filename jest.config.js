/**
 * Root (client app) jest configuration.
 *
 * Two projects, because the client tree has two genuinely different kinds of
 * test:
 *
 *   client-logic  – pure TypeScript logic under __tests__/ (lib/, services/,
 *                   hooks/, utils/, components/). Runs in a plain node
 *                   environment with ts-jest, exactly as it always has. Suites
 *                   here stub the native surface they need themselves.
 *   react-native  – suites under tests/ that load application modules which
 *                   reach the real `react-native` package (e.g. config/firebase
 *                   reads Platform.OS through the firebase SDK). react-native,
 *                   expo and the firebase RN entry points ship untranspiled
 *                   Flow/ESM, so this project uses react-native's own jest
 *                   preset: babel transform for node_modules, platform-aware
 *                   resolution (`haste`), and the native-module mocks in
 *                   react-native/jest/setup.js.
 *
 * Not covered here (separate sub-projects, separate runners):
 *   backend-runtime/  – own jest config (`cd backend-runtime && npx jest`)
 *   email-backend/    – vitest (`cd email-backend && npm test`). Its suites
 *                       import from 'vitest' and are ESM, so root jest can
 *                       never execute them; the compiled copies under
 *                       email-backend/dist/ are the same suites again.
 *   tests/firestore-rules/*.rules.test.mjs – need a running Firestore emulator
 *                       and are ESM; they have never been part of the root jest
 *                       run and still are not.
 */

/** ts-jest options shared by the logic project. */
const tsJestTransform = [
  'ts-jest',
  {
    // Disable type-checking diagnostics so tests can run even when source
    // files have type errors against the installed package type definitions.
    diagnostics: false,
    tsconfig: {
      // Use a relaxed config for tests — avoid Expo-specific options
      strict: false,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      jsx: 'react-jsx',
      // Node 20 runs async/await natively. Without an explicit target ts-jest
      // falls back to TypeScript's default (ES5) and downlevels every `await`
      // into a __awaiter/generator state machine, which burns several extra
      // microtask ticks per await. Suites that drive an async code path by
      // flushing a fixed number of `Promise.resolve()` ticks then observe the
      // hook mid-flight and fail. ES2020 keeps the emitted timing faithful to
      // what ships.
      target: 'ES2020',
      lib: ['ES2020', 'DOM'],
    },
  },
];

const moduleNameMapper = {
  // Icon package that drags react-native-svg (and therefore react-native) into
  // the import graph of otherwise pure modules. See the stub for details.
  '^lucide-react-native$': '<rootDir>/jest/stubs/lucideReactNative.js',
  '^@/(.*)$': '<rootDir>/$1',
};

// Native platform folders, build output, and sub-projects with their own
// runners must never be picked up by the root run.
const testPathIgnorePatterns = [
  '/node_modules/',
  '/backend-runtime/',
  '/email-backend/',
  '/android/',
  '/ios/',
  '<rootDir>/dist/',
  '<rootDir>/web-build/',
];

// Property-based suites run hundreds of fast-check cases per test. Under
// jest's parallel workers a single case can lose the CPU long enough to blow
// the 5s default, which turns real passes into flaky timeouts. `testTimeout` is
// top-level-only in jest 29 (it is dropped from project configs), so the budget
// is raised from a setup file. Raising it does not reduce what any test checks.
const setupFilesAfterEnv = ['<rootDir>/jest/setup/testTimeout.js'];

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'client-logic',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>'],
      testMatch: [
        '<rootDir>/__tests__/**/*.test.ts',
        '<rootDir>/__tests__/**/*.test.js',
      ],
      transform: {
        '^.+\\.tsx?$': tsJestTransform,
        // .js sources in this repo are a mix of CommonJS and ESM (e.g.
        // config/firebase.js). Without a transform jest loads them raw and ESM
        // ones die with "Cannot use import statement outside a module".
        '^.+\\.(js|jsx|cjs|mjs)$': 'babel-jest',
      },
      moduleNameMapper,
      testPathIgnorePatterns,
      setupFilesAfterEnv,
    },
    {
      displayName: 'react-native',
      preset: 'react-native',
      roots: ['<rootDir>'],
      testMatch: ['<rootDir>/tests/**/*.test.js'],
      // The preset's own transform covers .js/.ts/.tsx only. firebase's RN
      // entry point pulls in @firebase/util/dist/postinstall.mjs, so .mjs needs
      // babel too.
      transform: {
        '^.+\\.(js|jsx|mjs|cjs|ts|tsx)$': 'babel-jest',
      },
      // The preset only un-ignores react-native itself. Everything else listed
      // here ships untranspiled ESM/Flow that this project's import graph
      // reaches: expo/virtual/env.js (via expo-*), @firebase/* ESM builds
      // selected by the react-native package field, react-native-svg sources.
      transformIgnorePatterns: [
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-native-svg|firebase|@firebase))',
      ],
      setupFiles: ['<rootDir>/jest/setup/nativeModuleMocks.js'],
      moduleNameMapper,
      testPathIgnorePatterns,
      setupFilesAfterEnv,
    },
  ],
};
