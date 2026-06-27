/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.test.js',
    '**/tests/**/*.test.js',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      // Disable type-checking diagnostics so tests can run even when source
      // files have type errors against the installed package type definitions.
      diagnostics: false,
      tsconfig: {
        // Use a relaxed config for tests — avoid Expo-specific options
        strict: false,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        jsx: 'react-jsx',
      },
    }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  // Ignore backend and native platform folders
  testPathIgnorePatterns: [
    '/node_modules/',
    '/backend-runtime/',
    '/android/',
    '/ios/',
  ],
};
