import { defineConfig } from 'vitest/config'

// The store and its whole import graph (types, engine/time, engine/keyframes,
// engine/textPresets) are deliberately pure — no tauri, no DOM — so unit
// tests run in plain node. Keep it that way: anything that needs a webview
// belongs in the e2e suite (scripts/e2e.sh), not here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
