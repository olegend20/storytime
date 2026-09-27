import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescriptConfig from 'eslint-config-next/typescript'

/** eslint-config-next 16 ships flat configs directly - no FlatCompat needed. */
const config = [
  {
    ignores: [
      'node_modules/**',
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
