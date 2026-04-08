package com.ors.testing.user;

import java.net.URI;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/test-users")
public class UserController {
    private final UserRepository userRepository;

    public UserController(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @PostMapping
    public ResponseEntity<?> createUser(@RequestBody UserRequest request) {
        if (request.email() == null || request.email().isBlank() || request.fullName() == null || request.fullName().isBlank()) {
            return ResponseEntity.badRequest().body("Email and fullName are required.");
        }

        if (userRepository.existsByEmail(request.email())) {
            return ResponseEntity.badRequest().body("A user with this email already exists.");
        }

        User saved = userRepository.save(new User(request.email(), request.fullName()));
        return ResponseEntity.created(URI.create("/api/test-users/" + saved.getId())).body(UserResponse.from(saved));
    }

    @GetMapping("/{email}")
    public ResponseEntity<?> getUser(@PathVariable String email) {
        return userRepository.findByEmail(email)
            .<ResponseEntity<?>>map(user -> ResponseEntity.ok(UserResponse.from(user)))
            .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
