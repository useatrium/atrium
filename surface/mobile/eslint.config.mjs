import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import reactNativeA11y from 'eslint-plugin-react-native-a11y';
import tseslint from 'typescript-eslint';

const reactNativeA11yRules = reactNativeA11y.configs.all.rules;

export default [
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    ignores: [
      '**/node_modules/**',
      '**/.expo/**',
      '**/expo-env.d.ts',
      '**/android/**',
      '**/ios/**',
      '**/build/**',
      '**/dist/**',
      '**/coverage/**',
      '**/test/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
  },
  {
    files: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
      'react-native-a11y': reactNativeA11y,
    },
    rules: {
      ...reactNativeA11yRules,
      // The legacy plugin's "all" config requires accessibilityHint on every
      // labeled element; React Native treats hints as optional explanatory
      // text, and forcing them here would make already-labeled controls noisy.
      'react-native-a11y/has-accessibility-hint': 'off',
    },
  },
];
