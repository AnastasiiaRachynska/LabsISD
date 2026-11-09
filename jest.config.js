"use strict";

module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.js"],
  collectCoverageFrom: [
    "src/**/*.{js,cjs,mjs}",
    "!src/**/*.config.js",
    "!src/**/*.d.ts",
    "!src/wnt11/cli.js",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "json-summary"],
  coverageThreshold: {
    global: {
      branches: 85,
      statements: 85,
    },
  },
};
