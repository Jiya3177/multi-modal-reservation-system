import unittest

from src.calculator import Calculator


class CalculatorTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.calculator = Calculator()

    def test_add_returns_sum(self) -> None:
        self.assertEqual(self.calculator.add(5, 7), 12)

    def test_divide_returns_quotient(self) -> None:
        self.assertEqual(self.calculator.divide(20, 5), 4)

    def test_divide_by_zero_raises_value_error(self) -> None:
        with self.assertRaisesRegex(ValueError, "Cannot divide by zero."):
            self.calculator.divide(10, 0)


if __name__ == "__main__":
    unittest.main()
