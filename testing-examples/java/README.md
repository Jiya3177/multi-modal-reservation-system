# Java Test Examples

This folder contains isolated Java testing examples modeled after the requested patterns:

- JUnit 5 unit tests
- Spring Boot integration tests
- TestRestTemplate API checks
- Testcontainers-backed MySQL isolation

## Structure

- `src/main/java/com/ors/testing/pricing/PricingService.java`
- `src/test/java/com/ors/testing/pricing/PricingServiceTest.java`
- `src/main/java/com/ors/testing/user/*`
- `src/test/java/com/ors/testing/user/UserApiIntegrationTest.java`

## Run

```bash
cd testing-examples/java
mvn test
```

Notes:

- Docker must be running for the Testcontainers integration test.
- Maven is required to execute the Java tests.
