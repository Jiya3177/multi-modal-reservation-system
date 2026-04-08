import sqlite3

import pytest

from src.user_repository import UserRepository


@pytest.fixture
def repository() -> UserRepository:
    connection = sqlite3.connect(":memory:")
    try:
        yield UserRepository(connection)
    finally:
        connection.close()


def test_create_and_get_user(repository: UserRepository) -> None:
    created = repository.create_user("alice@example.com", "Alice Kapoor")

    found = repository.get_user_by_email("alice@example.com")

    assert found is not None
    assert found.user_id == created.user_id
    assert found.email == "alice@example.com"
    assert found.full_name == "Alice Kapoor"


def test_duplicate_email_raises_value_error(repository: UserRepository) -> None:
    repository.create_user("duplicate@example.com", "First User")

    with pytest.raises(ValueError, match="already exists"):
        repository.create_user("duplicate@example.com", "Second User")
