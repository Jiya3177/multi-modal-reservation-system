package com.ors.testing.user;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@Testcontainers
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class UserApiIntegrationTest {
    @Container
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.4")
        .withDatabaseName("ors_test")
        .withUsername("test")
        .withPassword("test");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", MYSQL::getJdbcUrl);
        registry.add("spring.datasource.username", MYSQL::getUsername);
        registry.add("spring.datasource.password", MYSQL::getPassword);
        registry.add("spring.jpa.hibernate.ddl-auto", () -> "update");
    }

    @LocalServerPort
    private int port;

    @Autowired
    private TestRestTemplate restTemplate;

    @Test
    void createAndFetchUser_succeeds() {
        UserRequest request = new UserRequest("api-user@example.com", "API User");

        ResponseEntity<UserResponse> createResponse = restTemplate.postForEntity(
            "http://localhost:" + port + "/api/test-users",
            request,
            UserResponse.class
        );

        assertEquals(HttpStatus.CREATED, createResponse.getStatusCode());
        assertNotNull(createResponse.getBody());
        assertEquals("api-user@example.com", createResponse.getBody().email());

        ResponseEntity<UserResponse> getResponse = restTemplate.getForEntity(
            "http://localhost:" + port + "/api/test-users/api-user@example.com",
            UserResponse.class
        );

        assertEquals(HttpStatus.OK, getResponse.getStatusCode());
        assertNotNull(getResponse.getBody());
        assertEquals("API User", getResponse.getBody().fullName());
    }

    @Test
    void createUser_rejectsDuplicateEmail() {
        UserRequest request = new UserRequest("duplicate-api@example.com", "First User");
        restTemplate.postForEntity("http://localhost:" + port + "/api/test-users", request, UserResponse.class);

        ResponseEntity<String> duplicateResponse = restTemplate.exchange(
            "http://localhost:" + port + "/api/test-users",
            HttpMethod.POST,
            new HttpEntity<>(new UserRequest("duplicate-api@example.com", "Second User")),
            String.class
        );

        assertEquals(HttpStatus.BAD_REQUEST, duplicateResponse.getStatusCode());
        assertEquals("A user with this email already exists.", duplicateResponse.getBody());
    }
}
