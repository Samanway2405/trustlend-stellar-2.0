import { describe, expect, it } from "vitest";
import {
  CONTRACTS,
  CONTRACT_KEYS,
  selectContracts,
} from "./contracts-manifest";

describe("contracts manifest", () => {
  it("has a unique key per contract", () => {
    expect(new Set(CONTRACT_KEYS).size).toBe(CONTRACT_KEYS.length);
  });

  it("has a unique env var per contract", () => {
    const envVars = CONTRACTS.map((contract) => contract.envVar);

    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it("has a unique wasm artifact per contract", () => {
    const wasm = CONTRACTS.map((contract) => contract.wasm);

    expect(new Set(wasm).size).toBe(wasm.length);
  });

  it("names every env var NEXT_PUBLIC_*_CONTRACT_ID", () => {
    for (const contract of CONTRACTS) {
      expect(contract.envVar).toMatch(/^NEXT_PUBLIC_[A-Z_]+_CONTRACT_ID$/);
    }
  });

  it("includes the pooled lending contract the app reads", () => {
    // lib/contracts/pooled-lending.ts requires this id, but the old deploy.sh
    // never deployed it.
    const keys = CONTRACTS.map((contract) => contract.key);

    expect(keys).toContain("pooled_lending");
  });

  it("deploys dependencies before the contracts that need them", () => {
    const order = CONTRACTS.map((contract) => contract.key);
    const before = (a: string, b: string) =>
      order.indexOf(a) < order.indexOf(b);

    // Governance is initialized with the lending + reputation ids.
    expect(before("lending", "governance")).toBe(true);
    expect(before("reputation", "governance")).toBe(true);

    // The multisig links to lending, default management and reputation.
    expect(before("lending", "multisig_admin")).toBe(true);
    expect(before("default_management", "multisig_admin")).toBe(true);
    expect(before("reputation", "multisig_admin")).toBe(true);

    // Vesting and airdrop are initialized with the TLEND token id.
    expect(before("tlend_token", "tlend_vesting")).toBe(true);
    expect(before("tlend_token", "tlend_airdrop")).toBe(true);
  });
});

describe("selectContracts", () => {
  it("returns everything when no filter is given", () => {
    expect(selectContracts().selected).toHaveLength(CONTRACTS.length);
    expect(selectContracts("").selected).toHaveLength(CONTRACTS.length);
  });

  it("selects only the requested contracts", () => {
    const { selected } = selectContracts("lending,escrow");

    expect(selected.map((contract) => contract.key)).toEqual(["escrow", "lending"]);
  });

  it("returns the canonical deploy order regardless of input order", () => {
    // Initialization depends on order, so a caller cannot reorder deploys.
    const { selected } = selectContracts("governance,reputation,lending");

    expect(selected.map((contract) => contract.key)).toEqual([
      "reputation",
      "lending",
      "governance",
    ]);
  });

  it("reports unknown keys instead of silently ignoring them", () => {
    const { selected, unknown } = selectContracts("lending,nope");

    expect(unknown).toEqual(["nope"]);
    expect(selected.map((contract) => contract.key)).toEqual(["lending"]);
  });

  it("tolerates whitespace and empty entries", () => {
    const { selected, unknown } = selectContracts(" lending , , escrow ");

    expect(unknown).toEqual([]);
    expect(selected.map((contract) => contract.key)).toEqual(["escrow", "lending"]);
  });
});
