package com.ors.testing.pricing;

import java.math.BigDecimal;

public class PricingService {
    public BigDecimal applyDiscount(BigDecimal amount, boolean premiumMember) {
        if (amount == null || amount.signum() < 0) {
            throw new IllegalArgumentException("Amount must be a non-negative value.");
        }

        if (!premiumMember) {
            return amount;
        }

        return amount.multiply(new BigDecimal("0.90"));
    }
}
