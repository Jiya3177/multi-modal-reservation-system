package com.ors.testing.pricing;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.math.BigDecimal;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class PricingServiceTest {
    private PricingService pricingService;

    @BeforeEach
    void setUp() {
        pricingService = new PricingService();
    }

    @Test
    void applyDiscount_returnsOriginalAmount_forRegularCustomer() {
        BigDecimal result = pricingService.applyDiscount(new BigDecimal("1000.00"), false);
        assertEquals(new BigDecimal("1000.00"), result);
    }

    @Test
    void applyDiscount_returnsTenPercentDiscount_forPremiumCustomer() {
        BigDecimal result = pricingService.applyDiscount(new BigDecimal("1000.00"), true);
        assertEquals(new BigDecimal("900.0000"), result);
    }

    @Test
    void applyDiscount_rejectsNegativeAmount() {
        assertThrows(IllegalArgumentException.class,
            () -> pricingService.applyDiscount(new BigDecimal("-1"), true));
    }
}
