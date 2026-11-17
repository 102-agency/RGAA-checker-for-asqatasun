import { defineConfig } from 'vitest/config'

// Deux projets : les tests unitaires (rapides, sans navigateur) et les pages-témoins,
// qui pilotent un vrai Chromium (un fichier à la fois, délais larges).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'fixtures',
          environment: 'node',
          include: ['tests/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
})
