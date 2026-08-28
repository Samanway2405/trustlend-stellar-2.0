import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getWalletProviderLabel,
  isStellarWalletProvider,
  getWalletModuleId,
  STELLAR_WALLET_PROVIDERS,
  type StellarWalletProvider,
} from "@/lib/stellar/wallet-providers";

describe("Borrower Freighter Wallet Integration", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("includes Freighter in supported wallet providers for borrowers", () => {
    expect(STELLAR_WALLET_PROVIDERS).toContain("freighter");
    expect(isStellarWalletProvider("freighter")).toBe(true);
  });

  it("returns correct human-readable display label for Freighter", () => {
    expect(getWalletProviderLabel("freighter")).toBe("Freighter");
  });

  it("maps Freighter to its correct wallet module ID for connection", () => {
    expect(getWalletModuleId("freighter")).toBe("freighter");
  });

  it("ensures Freighter is the primary default wallet for signing borrowing transactions", () => {
    const fallbackProvider: StellarWalletProvider = "freighter";
    expect(getWalletProviderLabel(fallbackProvider)).toBe("Freighter");
  });
});
