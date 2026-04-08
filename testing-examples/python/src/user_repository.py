import sqlite3
from dataclasses import dataclass


@dataclass(frozen=True)
class User:
    user_id: int
    email: str
    full_name: str


class UserRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                full_name TEXT NOT NULL
            )
            """
        )
        self.connection.commit()

    def create_user(self, email: str, full_name: str) -> User:
        try:
            cursor = self.connection.execute(
                "INSERT INTO users (email, full_name) VALUES (?, ?)",
                (email, full_name),
            )
            self.connection.commit()
        except sqlite3.IntegrityError as exc:
            raise ValueError("A user with this email already exists.") from exc

        return User(user_id=cursor.lastrowid, email=email, full_name=full_name)

    def get_user_by_email(self, email: str) -> User | None:
        row = self.connection.execute(
            "SELECT user_id, email, full_name FROM users WHERE email = ?",
            (email,),
        ).fetchone()
        if row is None:
            return None
        return User(user_id=row[0], email=row[1], full_name=row[2])
