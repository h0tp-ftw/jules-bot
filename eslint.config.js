import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

// Flat config. Lenient by design: the goal is to catch real mistakes without
// drowning an existing codebase in style noise (Prettier owns formatting). Rules
// that would only nag are set to 'warn' so `npm run lint` stays green in CI.
export default tseslint.config(
  {
    ignores: ['dist/**', 'prisma/migrations/**', '**/*.db', '.venv/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The config layer leans on `any` for the dynamic YAML/Discord shapes.
      '@typescript-eslint/no-explicit-any': 'off',
      // Warn (don't fail) on unused vars; allow intentional _-prefixed ones.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
)
