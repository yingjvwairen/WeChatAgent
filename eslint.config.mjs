import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'state/**',
      'audit-local/**',
      'release/**',
      'packages/voice-codec/silk-wasm/**',
    ],
  },
  {
    files: [
      'scripts/**/*.{js,mjs}',
      'packages/**/*.{js,mjs}',
      'components/qq-bridge/**/*.{js,mjs}',
      'apps/console-desktop/*.cjs',
      'public/console/*.{js,mjs}',
      'optional-extensions/**/*.{js,mjs}',
      'examples/plugins/**/*.{js,mjs}',
      '*.mjs',
    ],
    languageOptions: { ecmaVersion: 'latest', globals: globals.node },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-args': 'error',
    },
  },
  {
    files: ['public/console/*.{js,mjs}', 'optional-extensions/**/ui/*.{js,mjs}', 'examples/plugins/**/ui/*.{js,mjs}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/desktop-sender/**/*.mjs'],
    rules: { 'no-constant-condition': ['error', { checkLoops: false }] },
  },
  {
    files: [
      'scripts/desktop-sender/qt-visual-driver.mjs',
      'scripts/desktop-sender/qt-window-frames.mjs',
      'scripts/desktop-sender/qt-conversation-preparation.mjs',
      'scripts/desktop-sender/qt-focus-session.mjs',
      'scripts/desktop-sender/qt-voice-session.mjs',
      'scripts/desktop-sender/qt-quote-session.mjs',
    ],
    rules: { 'max-lines-per-function': ['error', { max: 250, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ['scripts/desktop-sender/qt-*.mjs', 'scripts/desktop-sender/quote-history-client.mjs'],
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] },
  },
  {
    files: [
      'scripts/desktop-sender/qt-*-session.mjs',
      'scripts/desktop-sender/qt-conversation-preparation.mjs',
      'scripts/desktop-sender/qt-quote-ocr.mjs',
      'scripts/desktop-sender/quote-history-client.mjs',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression[left.object.object.type='ThisExpression'][left.object.property.name='input']",
          message: 'Use the input owner’s state transitions.',
        },
        {
          selector: 'MemberExpression[property.name=/^(client|clientFactory|resolveLayoutWith)$/]',
          message: 'Issue session commands through the bound native connection.',
        },
      ],
    },
  },
];
