// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
    },
  },
  // Limit these relaxations to the UI code where they are currently very noisy.
  // Keeps lint output clean without weakening rules for scripts/backends.
  {
    files: [
      'app/**/*.{js,jsx,ts,tsx}',
      'components/**/*.{js,jsx,ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/exhaustive-deps': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'import/no-named-as-default': 'off',
    },
  },
  // On iOS/Android a raw react-native Modal hides toasts behind it. The
  // wrapper carries a toast host so toasts always draw on top.
  {
    files: [
      'app/**/*.{js,jsx,ts,tsx}',
      'components/**/*.{js,jsx,ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'react-native',
          importNames: ['Modal'],
          message: "Use `import { Modal } from '@/components/AppModal'` so toasts show above the modal on iOS/Android.",
        }],
      }],
    },
  },
]);
