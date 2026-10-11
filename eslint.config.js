import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // src/generated is emitted by scripts/generate-api.mjs; tsc still type-checks it strictly.
  { ignores: ['dist/**', 'node_modules/**', '.reference/**', 'data/**', 'src/generated/**'] },
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@openscreeps/engine', '@openscreeps/engine/*'],
              message: 'Server integrations use @openscreeps/game; the game owns its engine.',
            },
          ],
        },
      ],
      // Nest modules can be declarative classes whose behavior is supplied by decorators.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  prettier,
);
