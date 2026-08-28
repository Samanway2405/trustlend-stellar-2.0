/**
 * lib/risk/parameters.ts
 *
 * Core risk parameter models, validation bounds, default values, and
 * interest rate curve calculation math matching Soroban contract logic.
 */

export interface AssetRiskConfig {
  assetSymbol: string;
  assetAddress: string;
  assetName: string;
  /** Max Loan-To-Value in basis points (e.g. 7500 = 75.00%) */
  collateralFactorBps: number;
  /** Volatility buffer in basis points (e.g. 500 = 5.00%) */
  volatilityBps: number;
  /** Liquidation threshold in basis points (e.g. 8000 = 80.00%) */
  liquidationThresholdBps: number;
  /** Liquidation bonus/penalty in basis points (e.g. 500 = 5.00%) */
  liquidationBonusBps: number;
  /** Whether asset uses active decentralized price oracle feed */
  hasPriceOracle: boolean;
  /** Whether asset is currently whitelisted as collateral */
  isWhitelisted: boolean;
}

export interface InterestRateCurveConfig {
  poolId: number;
  poolName: string;
  /** Base borrow rate at 0% utilization in basis points (e.g. 200 = 2.00%) */
  baseRateBps: number;
  /** Slope 1 rate multiplier up to kink in basis points (e.g. 1000 = 10.00%) */
  multiplierPerSlopeBps: number;
  /** Optimal utilization target (kink) in basis points (e.g. 8000 = 80.00%) */
  kinkBps: number;
  /** Steep slope 2 multiplier past kink in basis points (e.g. 5000 = 50.00%) */
  jumpMultiplierBps: number;
  /** Protocol reserve cut from interest in basis points (e.g. 1000 = 10.00%) */
  reserveFactorBps: number;
}

export interface ProtocolFeeConfig {
  /** Flash loan fee in basis points (e.g. 9 = 0.09%) */
  flashLoanFeeBps: number;
  /** Platform protocol fee in basis points of interest (e.g. 100 = 1.00%) */
  platformFeeBps: number;
  /** Rate switch fee in basis points (e.g. 50 = 0.50%) */
  rateSwitchFeeBps: number;
  /** Cooldown between rate switches in seconds (e.g. 86400 = 24h) */
  rateSwitchCooldownSecs: number;
  /** Emergency protocol pause state */
  isPaused: boolean;
  /** Price oracle contract address */
  priceOracleAddress: string;
}

export interface RiskParameterUpdateAudit {
  id: string;
  category: "collateral_ltv" | "interest_curve" | "protocol_fees" | "circuit_breaker";
  targetName: string;
  updatedBy: string;
  previousValue: string;
  newValue: string;
  reason: string;
  timestamp: string;
  txHash?: string;
}

export interface RiskParametersState {
  assets: AssetRiskConfig[];
  curves: InterestRateCurveConfig[];
  protocolFees: ProtocolFeeConfig;
  auditHistory: RiskParameterUpdateAudit[];
}

// ─── Safety Bounds & Constraints ─────────────────────────────────────────────

export const RISK_PARAMETER_BOUNDS = {
  MIN_COLLATERAL_FACTOR_BPS: 1000,   // 10%
  MAX_COLLATERAL_FACTOR_BPS: 9500,   // 95%
  MIN_KINK_BPS: 1000,                // 10%
  MAX_KINK_BPS: 9000,                // 90%
  MAX_BASE_RATE_BPS: 5000,           // 50%
  MAX_MULTIPLIER_BPS: 10000,         // 100%
  MAX_JUMP_MULTIPLIER_BPS: 20000,    // 200%
  MAX_RESERVE_FACTOR_BPS: 5000,      // 50%
  MAX_FLASH_LOAN_FEE_BPS: 500,       // 5%
  MAX_PLATFORM_FEE_BPS: 1000,        // 10%
  MAX_BPS: 10000,
} as const;

// ─── Default Initial State ────────────────────────────────────────────────────

export const DEFAULT_ASSET_RISK_CONFIGS: AssetRiskConfig[] = [
  {
    assetSymbol: "XLM",
    assetAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    assetName: "Native Stellar Lumens",
    collateralFactorBps: 7500, // 75% LTV
    volatilityBps: 500,       // 5%
    liquidationThresholdBps: 8000, // 80%
    liquidationBonusBps: 500, // 5%
    hasPriceOracle: true,
    isWhitelisted: true,
  },
  {
    assetSymbol: "USDC",
    assetAddress: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWUIE3USDC777777777",
    assetName: "USD Coin (Circle)",
    collateralFactorBps: 8500, // 85% LTV
    volatilityBps: 200,       // 2%
    liquidationThresholdBps: 9000, // 90%
    liquidationBonusBps: 300, // 3%
    hasPriceOracle: true,
    isWhitelisted: true,
  },
  {
    assetSymbol: "WBTC",
    assetAddress: "CAWBTC77777777777777777777777777777777777777777777777777",
    assetName: "Wrapped Bitcoin",
    collateralFactorBps: 6500, // 65% LTV
    volatilityBps: 800,       // 8%
    liquidationThresholdBps: 7200, // 72%
    liquidationBonusBps: 700, // 7%
    hasPriceOracle: true,
    isWhitelisted: true,
  },
];

export const DEFAULT_INTEREST_RATE_CURVES: InterestRateCurveConfig[] = [
  {
    poolId: 1,
    poolName: "USDC Core Lending Pool",
    baseRateBps: 200,             // 2.00%
    multiplierPerSlopeBps: 1000,  // 10.00%
    kinkBps: 8000,                // 80.00%
    jumpMultiplierBps: 5000,      // 50.00%
    reserveFactorBps: 1000,       // 10.00%
  },
  {
    poolId: 2,
    poolName: "XLM Micro-Credit Pool",
    baseRateBps: 300,             // 3.00%
    multiplierPerSlopeBps: 1200,  // 12.00%
    kinkBps: 7500,                // 75.00%
    jumpMultiplierBps: 6000,      // 60.00%
    reserveFactorBps: 1200,       // 12.00%
  },
];

export const DEFAULT_PROTOCOL_FEES: ProtocolFeeConfig = {
  flashLoanFeeBps: 9,              // 0.09%
  platformFeeBps: 100,             // 1.00%
  rateSwitchFeeBps: 50,            // 0.50%
  rateSwitchCooldownSecs: 86400,   // 24 hours
  isPaused: false,
  priceOracleAddress: "CDORACLE77777777777777777777777777777777777777777777777",
};

export const INITIAL_RISK_AUDIT_LOG: RiskParameterUpdateAudit[] = [
  {
    id: "audit-1",
    category: "collateral_ltv",
    targetName: "USDC Collateral Factor",
    updatedBy: "admin@trustlend.org",
    previousValue: "80.00% (8000 bps)",
    newValue: "85.00% (8500 bps)",
    reason: "Increased stablecoin collateral factor after liquidity depth verification",
    timestamp: new Date(Date.now() - 4 * 86400 * 1000).toISOString(),
    txHash: "0x4b7e9a...f12",
  },
  {
    id: "audit-2",
    category: "interest_curve",
    targetName: "USDC Core Pool Kink",
    updatedBy: "admin@trustlend.org",
    previousValue: "75.00% (7500 bps)",
    newValue: "80.00% (8000 bps)",
    reason: "Adjusted optimal utilization target to increase capital efficiency",
    timestamp: new Date(Date.now() - 10 * 86400 * 1000).toISOString(),
    txHash: "0x8f2d1c...e84",
  },
];

// ─── Interest Rate Curve Math ─────────────────────────────────────────────────

/**
 * Calculates the borrow rate in basis points for a given pool configuration
 * and utilization rate.
 * Matches Soroban `PooledLendingContract::compute_borrow_rate_bps`.
 */
export function computeBorrowRateBps(
  config: InterestRateCurveConfig,
  utilizationBps: number
): number {
  const util = Math.max(0, Math.min(RISK_PARAMETER_BOUNDS.MAX_BPS, utilizationBps));
  if (util === 0) {
    return config.baseRateBps;
  }

  if (util <= config.kinkBps) {
    const slopeComponent = Math.floor(
      (util * config.multiplierPerSlopeBps) / config.kinkBps
    );
    return config.baseRateBps + slopeComponent;
  } else {
    const excess = util - config.kinkBps;
    const jumpDenominator = RISK_PARAMETER_BOUNDS.MAX_BPS - config.kinkBps;
    const jumpComponent = Math.floor(
      (excess * config.jumpMultiplierBps) / jumpDenominator
    );
    return config.baseRateBps + config.multiplierPerSlopeBps + jumpComponent;
  }
}

/**
 * Calculates the supply rate in basis points for a given pool configuration,
 * utilization, and borrow rate.
 * Matches Soroban `PooledLendingContract::compute_supply_rate_bps`.
 */
export function computeSupplyRateBps(
  config: InterestRateCurveConfig,
  utilizationBps: number,
  borrowRateBps: number
): number {
  if (utilizationBps === 0 || borrowRateBps === 0) {
    return 0;
  }
  const maxBps = RISK_PARAMETER_BOUNDS.MAX_BPS;
  const reserveAdjustment = maxBps - config.reserveFactorBps;
  const numerator = borrowRateBps * utilizationBps * reserveAdjustment;
  return Math.floor(numerator / (maxBps * maxBps));
}

/**
 * Generates an array of sample data points across 0% to 100% utilization
 * for rendering the interest rate curve chart.
 */
export function generateRateCurvePoints(config: InterestRateCurveConfig) {
  const points = [];
  for (let util = 0; util <= 100; util += 5) {
    const utilBps = util * 100;
    const borrowBps = computeBorrowRateBps(config, utilBps);
    const supplyBps = computeSupplyRateBps(config, utilBps, borrowBps);

    points.push({
      utilizationPct: util,
      borrowApyPct: Number((borrowBps / 100).toFixed(2)),
      supplyApyPct: Number((supplyBps / 100).toFixed(2)),
      isKink: Math.abs(utilBps - config.kinkBps) < 250,
    });
  }
  return points;
}

// ─── Validation Functions ─────────────────────────────────────────────────────

export function validateAssetRiskConfig(config: Partial<AssetRiskConfig>): {
  valid: boolean;
  error?: string;
} {
  if (config.collateralFactorBps !== undefined) {
    if (
      config.collateralFactorBps < RISK_PARAMETER_BOUNDS.MIN_COLLATERAL_FACTOR_BPS ||
      config.collateralFactorBps > RISK_PARAMETER_BOUNDS.MAX_COLLATERAL_FACTOR_BPS
    ) {
      return {
        valid: false,
        error: `Collateral Factor must be between ${
          RISK_PARAMETER_BOUNDS.MIN_COLLATERAL_FACTOR_BPS / 100
        }% and ${RISK_PARAMETER_BOUNDS.MAX_COLLATERAL_FACTOR_BPS / 100}%`,
      };
    }
  }

  if (config.volatilityBps !== undefined && (config.volatilityBps < 0 || config.volatilityBps > 5000)) {
    return { valid: false, error: "Volatility buffer must be between 0% and 50%" };
  }

  if (
    config.liquidationThresholdBps !== undefined &&
    config.collateralFactorBps !== undefined &&
    config.liquidationThresholdBps < config.collateralFactorBps
  ) {
    return {
      valid: false,
      error: "Liquidation threshold cannot be lower than the collateral factor (max LTV)",
    };
  }

  return { valid: true };
}

export function validateInterestRateCurveConfig(config: Partial<InterestRateCurveConfig>): {
  valid: boolean;
  error?: string;
} {
  if (
    config.baseRateBps !== undefined &&
    (config.baseRateBps < 0 || config.baseRateBps > RISK_PARAMETER_BOUNDS.MAX_BASE_RATE_BPS)
  ) {
    return {
      valid: false,
      error: `Base rate must be between 0% and ${RISK_PARAMETER_BOUNDS.MAX_BASE_RATE_BPS / 100}%`,
    };
  }

  if (
    config.kinkBps !== undefined &&
    (config.kinkBps < RISK_PARAMETER_BOUNDS.MIN_KINK_BPS ||
      config.kinkBps > RISK_PARAMETER_BOUNDS.MAX_KINK_BPS)
  ) {
    return {
      valid: false,
      error: `Kink must be between ${RISK_PARAMETER_BOUNDS.MIN_KINK_BPS / 100}% and ${
        RISK_PARAMETER_BOUNDS.MAX_KINK_BPS / 100
      }%`,
    };
  }

  if (
    config.jumpMultiplierBps !== undefined &&
    (config.jumpMultiplierBps < 0 ||
      config.jumpMultiplierBps > RISK_PARAMETER_BOUNDS.MAX_JUMP_MULTIPLIER_BPS)
  ) {
    return {
      valid: false,
      error: `Jump multiplier must be between 0% and ${
        RISK_PARAMETER_BOUNDS.MAX_JUMP_MULTIPLIER_BPS / 100
      }%`,
    };
  }

  if (
    config.reserveFactorBps !== undefined &&
    (config.reserveFactorBps < 0 ||
      config.reserveFactorBps > RISK_PARAMETER_BOUNDS.MAX_RESERVE_FACTOR_BPS)
  ) {
    return {
      valid: false,
      error: `Reserve factor must be between 0% and ${
        RISK_PARAMETER_BOUNDS.MAX_RESERVE_FACTOR_BPS / 100
      }%`,
    };
  }

  return { valid: true };
}

export function validateProtocolFeeConfig(config: Partial<ProtocolFeeConfig>): {
  valid: boolean;
  error?: string;
} {
  if (
    config.flashLoanFeeBps !== undefined &&
    (config.flashLoanFeeBps < 0 ||
      config.flashLoanFeeBps > RISK_PARAMETER_BOUNDS.MAX_FLASH_LOAN_FEE_BPS)
  ) {
    return {
      valid: false,
      error: `Flash loan fee cannot exceed ${
        RISK_PARAMETER_BOUNDS.MAX_FLASH_LOAN_FEE_BPS / 100
      }%`,
    };
  }

  if (
    config.platformFeeBps !== undefined &&
    (config.platformFeeBps < 0 ||
      config.platformFeeBps > RISK_PARAMETER_BOUNDS.MAX_PLATFORM_FEE_BPS)
  ) {
    return {
      valid: false,
      error: `Platform fee cannot exceed ${
        RISK_PARAMETER_BOUNDS.MAX_PLATFORM_FEE_BPS / 100
      }%`,
    };
  }

  return { valid: true };
}
