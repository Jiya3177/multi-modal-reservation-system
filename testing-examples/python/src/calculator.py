class Calculator:
    def add(self, left: float, right: float) -> float:
        return left + right

    def divide(self, dividend: float, divisor: float) -> float:
        if divisor == 0:
            raise ValueError("Cannot divide by zero.")
        return dividend / divisor
