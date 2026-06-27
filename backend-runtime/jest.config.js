/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      diagnostics: false,
      tsconfig: {
        strict: false,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        module: 'CommonJS',
        target: 'ES2020',
        resolveJsonModule: true,
        skipLibCheck: true,
        types: ['node', 'jest'],
        typeRoots: [
          '../node_modules/@types',
          'node_modules/@types',
        ],
      },
    }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^pure-rand$': '<rootDir>/../node_modules/jest-circus/node_modules/pure-rand',
    // Fix send/http-errors resolving statuses@1.x (root) instead of statuses@2.x (send/node_modules)
    // when moduleDirectories includes the root node_modules.
    '^statuses$': '<rootDir>/../node_modules/send/node_modules/statuses',
  },
  moduleDirectories: ['node_modules', '<rootDir>/../node_modules'],
  // fast-check lives in the root node_modules
  modulePaths: ['<rootDir>/../node_modules'],
};
