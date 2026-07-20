module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/e2e/**/*.spec.ts'],
  verbose: true,
  // Tier 4 intentionally runs four sequential CLI lifecycles with countdowns.
  testTimeout: 30000
};
