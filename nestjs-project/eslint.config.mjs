// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // jest.Mocked<Repository<T>>/jest.Mocked<Service> fixtures are the
    // standard NestJS testing pattern, but `unbound-method` has no concept
    // of Jest mocks — it flags every `expect(mock.method).toHaveBeenCalled...`
    // as an unbound `this`-dependent class method, which is a false positive
    // for a mock that never uses `this`. Disabling the base rule for test
    // files (instead of the real fix, eslint-plugin-jest's aware override)
    // avoids adding a new dependency for a test-only false positive.
    files: ['**/*.spec.ts', '**/*.integration-spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
