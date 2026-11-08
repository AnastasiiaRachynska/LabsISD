"use strict";

const jestConfig = require("../../jest.config");

describe("Jest coverage gate", () => {
  test("requires at least 85 percent statement and branch coverage", () => {
    expect(jestConfig.coverageThreshold.global).toMatchObject({
      statements: 85,
      branches: 85,
    });
  });

  test("limits measured source to the application source directory", () => {
    expect(jestConfig.collectCoverageFrom).toContain("src/**/*.{js,cjs,mjs}");
    expect(jestConfig.collectCoverageFrom).toContain("!src/**/*.config.js");
    expect(jestConfig.collectCoverageFrom).toContain("!src/**/*.d.ts");
  });
});
