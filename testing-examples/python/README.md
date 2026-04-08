# Python Test Examples

This folder contains isolated Python testing examples modeled after the requested patterns:

- unit tests with `unittest`
- integration tests with `pytest`
- SQLite in-memory test isolation

## Structure

- `src/calculator.py`: simple calculator module
- `src/user_repository.py`: SQLite-backed repository example
- `tests/unit/test_calculator.py`: `unittest` unit tests
- `tests/integration/test_user_repository.py`: `pytest` integration tests

## Run

```bash
cd testing-examples/python
python3 -m unittest tests/unit/test_calculator.py
python3 -m pip install -r requirements-dev.txt
python3 -m pytest tests/integration
```
