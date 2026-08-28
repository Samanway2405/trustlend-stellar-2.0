import { describe, expect, it } from "vitest";
import {
  DEFAULT_TREASURY_SIGNERS,
  TREASURY_THRESHOLD,
  TREASURY_SIGNERS_COUNT,
  isAuthorizedSigner,
  canExecuteProposal,
  createMultisigProposal,
  signMultisigProposal,
  revokeProposalSignature,
  executeMultisigProposal,
} from "@/lib/treasury/multisig";

describe("Multi-Signature Treasury Wallet Support (#257)", () => {
  it("enforces 3-of-5 signature configuration constants", () => {
    expect(TREASURY_THRESHOLD).toBe(3);
    expect(TREASURY_SIGNERS_COUNT).toBe(5);
    expect(DEFAULT_TREASURY_SIGNERS).toHaveLength(5);
  });

  it("validates authorized treasury admin signers", () => {
    const validSigner = DEFAULT_TREASURY_SIGNERS[0].address;
    expect(isAuthorizedSigner(validSigner)).toBe(true);

    const invalidAddress = "GBRANDOMUSERWALLET1234567890ABCDEF";
    expect(isAuthorizedSigner(invalidAddress)).toBe(false);
  });

  it("creates a multisig proposal with proposer's initial signature (1 of 3)", () => {
    const proposer = DEFAULT_TREASURY_SIGNERS[0].address;
    const proposal = createMultisigProposal({
      id: 1,
      title: "Distribute Treasury 50/50",
      description: "Send 5,000 to insurance and 5,000 to DAO",
      action: {
        type: "distribute",
        asset: "USDC",
        amount: 10000,
        insuranceShareBps: 5000,
        daoShareBps: 5000,
      },
      proposerAddress: proposer,
    });

    expect(proposal.id).toBe(1);
    expect(proposal.threshold).toBe(3);
    expect(proposal.totalSigners).toBe(5);
    expect(proposal.approvals).toEqual([proposer]);
    expect(proposal.status).toBe("pending");
    expect(canExecuteProposal(proposal)).toBe(false);
  });

  it("accumulates signatures and transitions to 'ready' when 3 of 5 admins sign", () => {
    const admin1 = DEFAULT_TREASURY_SIGNERS[0].address;
    const admin2 = DEFAULT_TREASURY_SIGNERS[1].address;
    const admin3 = DEFAULT_TREASURY_SIGNERS[2].address;

    let proposal = createMultisigProposal({
      id: 2,
      title: "Collect Protocol Fees",
      description: "Collect fees from lending pools",
      action: {
        type: "collect_fees",
        asset: "USDC",
        amount: 2500,
      },
      proposerAddress: admin1,
    });

    // Signer 2 approves (2 of 3)
    const res2 = signMultisigProposal(proposal, admin2);
    expect(res2.success).toBe(true);
    proposal = res2.proposal;
    expect(proposal.approvals).toHaveLength(2);
    expect(proposal.status).toBe("pending");
    expect(canExecuteProposal(proposal)).toBe(false);

    // Signer 3 approves (3 of 3 -> Ready)
    const res3 = signMultisigProposal(proposal, admin3);
    expect(res3.success).toBe(true);
    proposal = res3.proposal;
    expect(proposal.approvals).toHaveLength(3);
    expect(proposal.status).toBe("ready");
    expect(canExecuteProposal(proposal)).toBe(true);
  });

  it("rejects duplicate signatures from the same admin", () => {
    const admin1 = DEFAULT_TREASURY_SIGNERS[0].address;
    const proposal = createMultisigProposal({
      id: 3,
      title: "Transfer Allocation",
      description: "Transfer funds to grant recipient",
      action: {
        type: "transfer",
        asset: "USDC",
        amount: 1000,
        recipient: "GBRECIPIENT123",
      },
      proposerAddress: admin1,
    });

    const res = signMultisigProposal(proposal, admin1);
    expect(res.success).toBe(false);
    expect(res.error).toContain("already approved");
  });

  it("rejects signatures from unauthorized non-signers", () => {
    const admin1 = DEFAULT_TREASURY_SIGNERS[0].address;
    const proposal = createMultisigProposal({
      id: 4,
      title: "Set Rules",
      description: "Update distribution ratio",
      action: {
        type: "set_rules",
        insuranceShareBps: 6000,
        daoShareBps: 4000,
      },
      proposerAddress: admin1,
    });

    const res = signMultisigProposal(proposal, "GBUNAUTHORIZEDATTACKER");
    expect(res.success).toBe(false);
    expect(res.error).toContain("not an authorized treasury signer");
  });

  it("allows revoking signatures before execution", () => {
    const admin1 = DEFAULT_TREASURY_SIGNERS[0].address;
    const admin2 = DEFAULT_TREASURY_SIGNERS[1].address;
    const admin3 = DEFAULT_TREASURY_SIGNERS[2].address;

    let proposal = createMultisigProposal({
      id: 5,
      title: "Test Revoke",
      description: "Test signature revocation",
      action: {
        type: "collect_fees",
        asset: "USDC",
        amount: 1000,
      },
      proposerAddress: admin1,
    });

    proposal = signMultisigProposal(proposal, admin2).proposal;
    proposal = signMultisigProposal(proposal, admin3).proposal;
    expect(proposal.status).toBe("ready");

    // Admin 3 revokes
    const revokeRes = revokeProposalSignature(proposal, admin3);
    expect(revokeRes.success).toBe(true);
    proposal = revokeRes.proposal;
    expect(proposal.approvals).toHaveLength(2);
    expect(proposal.status).toBe("pending");
    expect(canExecuteProposal(proposal)).toBe(false);
  });

  it("executes proposal only when threshold of 3 signatures is satisfied", () => {
    const admin1 = DEFAULT_TREASURY_SIGNERS[0].address;
    const admin2 = DEFAULT_TREASURY_SIGNERS[1].address;
    const admin3 = DEFAULT_TREASURY_SIGNERS[2].address;

    let proposal = createMultisigProposal({
      id: 6,
      title: "Execution Flow",
      description: "Full propose -> sign -> execute lifecycle",
      action: {
        type: "distribute",
        asset: "USDC",
        amount: 5000,
        insuranceShareBps: 5000,
        daoShareBps: 5000,
      },
      proposerAddress: admin1,
    });

    // Attempt execution with only 1 signature -> Fails
    const earlyExec = executeMultisigProposal(proposal, admin1);
    expect(earlyExec.success).toBe(false);
    expect(earlyExec.error).toContain("Insufficient signatures");

    // Collect 2nd and 3rd signatures
    proposal = signMultisigProposal(proposal, admin2).proposal;
    proposal = signMultisigProposal(proposal, admin3).proposal;

    // Execution with 3 signatures -> Succeeds
    const finalExec = executeMultisigProposal(proposal, admin1, "0xabc123txhash");
    expect(finalExec.success).toBe(true);
    expect(finalExec.proposal.status).toBe("executed");
    expect(finalExec.proposal.txHash).toBe("0xabc123txhash");
    expect(finalExec.proposal.executedBy).toBe(admin1);
  });
});
