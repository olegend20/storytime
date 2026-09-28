import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescriptConfig from 'eslint-config-next/typescript'

/** eslint-config-next 16 ships flat configs directly - no FlatCompat needed. */
const config = [
  {
    ignores: [
      'node_modules/**',
      // Agent worktrees are separate full checkouts (their own node_modules and their own
      // in-flight code). Linting them reports thousands of problems that belong to another
      // lane's branch, not to this one.
      '.claude/**',
      '.next/**',
      'storytime-plan/**',
      '.archive/**',
      'test/fixtures/**',
      'eval/results/**',
    ],
  },
  ...coreWebVitals,
  ...typescriptConfig,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]

export default config
