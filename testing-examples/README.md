# Cross-Language Testing Examples

This workspace adds isolated Python and Java test suites inspired by the provided testing guide, without modifying the existing Node.js reservation app.

## Added

- `python/`
  - `unittest` unit tests for a calculator module
  - `pytest` integration tests for a SQLite-backed user repository
- `java/`
  - JUnit 5 unit tests for a pricing service
  - Spring Boot + TestRestTemplate + Testcontainers integration tests for a user API

## Why this layout

- Keeps the current Node.js project untouched
- Provides ready-to-run examples with clear separation
- Mirrors the requested unit/integration testing patterns
