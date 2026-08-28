import { NextRequest, NextResponse } from "next/server";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import {
  DEFAULT_TREASURY_SIGNERS,
  TREASURY_THRESHOLD,
  TREASURY_SIGNERS_COUNT,
  TreasuryMultisigProposal,
  TreasurySigner,
  createMultisigProposal,
  signMultisigProposal,
  revokeProposalSignature,
  executeMultisigProposal,
  isAuthorizedSigner,
} from "@/lib/treasury/multisig";

export interface DistributionHistoryItem {
  id: number;
  timestamp: string;
  asset: string;
  insuranceAmount: number;
  daoAmount: number;
  status: "Completed" | "Pending";
  txHash: string;
  signaturesCount?: number;
  approvedBy?: string[];
}

export interface TreasuryMetrics {
  currentBalance: number;
  totalCollected: number;
  totalDistributedInsurance: number;
  totalDistributedDao: number;
  rules: {
    insuranceShareBps: number;
    daoShareBps: number;
  };
  asset: string;
  multisig: {
    threshold: number;
    totalSigners: number;
    signers: TreasurySigner[];
    activeProposals: TreasuryMultisigProposal[];
    executedProposals: TreasuryMultisigProposal[];
  };
  history: DistributionHistoryItem[];
}

// Initial Mock Proposals for 3-of-5 Multi-Sig Treasury
const mockProposals: TreasuryMultisigProposal[] = [
  {
    id: 101,
    title: "Monthly 50/50 Treasury Distribution (Insurance & DAO)",
    description: "Distribute 12,500 USDC accumulated from protocol fees to Insurance Fund (50%) and DAO Governance (50%).",
    action: {
      type: "distribute",
      asset: "USDC",
      amount: 12500,
      insuranceShareBps: 5000,
      daoShareBps: 5000,
    },
    proposer: DEFAULT_TREASURY_SIGNERS[0].address,
    proposerName: DEFAULT_TREASURY_SIGNERS[0].name,
    approvals: [
      DEFAULT_TREASURY_SIGNERS[0].address,
      DEFAULT_TREASURY_SIGNERS[1].address,
    ],
    threshold: TREASURY_THRESHOLD,
    totalSigners: TREASURY_SIGNERS_COUNT,
    status: "pending", // 2 of 3 signed
    createdAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
  },
  {
    id: 100,
    title: "Collect Lending Pool Protocol Fees Q3",
    description: "Collect accrued fees from secondary lending pools into the main Treasury account.",
    action: {
      type: "collect_fees",
      asset: "USDC",
      amount: 5000,
    },
    proposer: DEFAULT_TREASURY_SIGNERS[1].address,
    proposerName: DEFAULT_TREASURY_SIGNERS[1].name,
    approvals: [
      DEFAULT_TREASURY_SIGNERS[0].address,
      DEFAULT_TREASURY_SIGNERS[1].address,
      DEFAULT_TREASURY_SIGNERS[2].address,
    ],
    threshold: TREASURY_THRESHOLD,
    totalSigners: TREASURY_SIGNERS_COUNT,
    status: "executed",
    createdAt: new Date(Date.now() - 14 * 86400 * 1000).toISOString(),
    executedAt: new Date(Date.now() - 12 * 86400 * 1000).toISOString(),
    executedBy: DEFAULT_TREASURY_SIGNERS[2].address,
    txHash: "0x8f3c1b...e92",
  },
];

// Mock/Initial Treasury State
const mockTreasuryState: TreasuryMetrics = {
  currentBalance: 12500.50,
  totalCollected: 45000.00,
  totalDistributedInsurance: 16249.75,
  totalDistributedDao: 16249.75,
  rules: {
    insuranceShareBps: 5000, // 50%
    daoShareBps: 5000,       // 50%
  },
  asset: "USDC",
  multisig: {
    threshold: TREASURY_THRESHOLD,
    totalSigners: TREASURY_SIGNERS_COUNT,
    signers: DEFAULT_TREASURY_SIGNERS,
    activeProposals: mockProposals.filter((p) => p.status === "pending" || p.status === "ready"),
    executedProposals: mockProposals.filter((p) => p.status === "executed" || p.status === "cancelled"),
  },
  history: [
    {
      id: 1,
      timestamp: new Date(Date.now() - 7 * 86400 * 1000).toISOString(),
      asset: "USDC",
      insuranceAmount: 8124.875,
      daoAmount: 8124.875,
      status: "Completed",
      txHash: "0x7a8f9c...b12",
      signaturesCount: 3,
      approvedBy: [
        DEFAULT_TREASURY_SIGNERS[0].address,
        DEFAULT_TREASURY_SIGNERS[1].address,
        DEFAULT_TREASURY_SIGNERS[3].address,
      ],
    },
    {
      id: 2,
      timestamp: new Date(Date.now() - 30 * 86400 * 1000).toISOString(),
      asset: "USDC",
      insuranceAmount: 8124.875,
      daoAmount: 8124.875,
      status: "Completed",
      txHash: "0x3e1d4a...f89",
      signaturesCount: 4,
      approvedBy: [
        DEFAULT_TREASURY_SIGNERS[0].address,
        DEFAULT_TREASURY_SIGNERS[2].address,
        DEFAULT_TREASURY_SIGNERS[3].address,
        DEFAULT_TREASURY_SIGNERS[4].address,
      ],
    },
  ],
};

function updateMultisigProposalsLists() {
  mockTreasuryState.multisig.activeProposals = mockProposals.filter(
    (p) => p.status === "pending" || p.status === "ready"
  );
  mockTreasuryState.multisig.executedProposals = mockProposals.filter(
    (p) => p.status === "executed" || p.status === "cancelled"
  );
}

export async function GET(request: NextRequest) {
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  updateMultisigProposalsLists();
  return NextResponse.json(mockTreasuryState, { status: 200 });
}

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const body = await request.json();
    const { action, proposalId, signerAddress, proposalData, amount, title, description } = body;

    // ── 1. Propose New Multisig Treasury Transaction ───────────────────────────
    if (action === "propose") {
      const proposer = signerAddress || DEFAULT_TREASURY_SIGNERS[0].address;
      const signerObj = DEFAULT_TREASURY_SIGNERS.find(
        (s) => s.address.toLowerCase() === String(proposer).toLowerCase()
      );

      const actionPayload = proposalData?.action || {
        type: proposalData?.type || "distribute",
        asset: proposalData?.asset || mockTreasuryState.asset,
        amount: Number(proposalData?.amount || amount || mockTreasuryState.currentBalance),
        insuranceShareBps: mockTreasuryState.rules.insuranceShareBps,
        daoShareBps: mockTreasuryState.rules.daoShareBps,
      };

      const newProposal = createMultisigProposal({
        id: mockProposals.length + 101,
        title: title || `Treasury ${String(actionPayload.type).toUpperCase()} Proposal`,
        description: description || `Multi-sig treasury operation proposed by ${signerObj?.name || proposer.slice(0, 12)}`,
        action: actionPayload,
        proposerAddress: proposer,
        proposerName: signerObj?.name,
      });

      mockProposals.unshift(newProposal);
      updateMultisigProposalsLists();

      return NextResponse.json(
        {
          message: `Multi-sig proposal #${newProposal.id} created. 1 of 3 required signatures recorded.`,
          proposal: newProposal,
          data: mockTreasuryState,
        },
        { status: 201 }
      );
    }

    // ── 2. Sign / Approve Multisig Proposal ────────────────────────────────────
    if (action === "sign" || action === "approve") {
      const targetProposal = mockProposals.find((p) => p.id === Number(proposalId));
      if (!targetProposal) {
        return NextResponse.json({ error: `Proposal #${proposalId} not found.` }, { status: 404 });
      }

      const signer = signerAddress || DEFAULT_TREASURY_SIGNERS[1].address;
      const signResult = signMultisigProposal(targetProposal, signer);

      if (!signResult.success) {
        return NextResponse.json({ error: signResult.error }, { status: 400 });
      }

      // Update in array
      const idx = mockProposals.findIndex((p) => p.id === Number(proposalId));
      if (idx !== -1) {
        mockProposals[idx] = signResult.proposal;
      }
      updateMultisigProposalsLists();

      return NextResponse.json(
        {
          message: `Signature recorded for proposal #${proposalId} (${signResult.proposal.approvals.length}/${signResult.proposal.threshold} signatures).`,
          proposal: signResult.proposal,
          data: mockTreasuryState,
        },
        { status: 200 }
      );
    }

    // ── 3. Revoke Signature ───────────────────────────────────────────────────
    if (action === "revoke") {
      const targetProposal = mockProposals.find((p) => p.id === Number(proposalId));
      if (!targetProposal) {
        return NextResponse.json({ error: `Proposal #${proposalId} not found.` }, { status: 404 });
      }

      const signer = signerAddress || DEFAULT_TREASURY_SIGNERS[1].address;
      const revokeResult = revokeProposalSignature(targetProposal, signer);

      if (!revokeResult.success) {
        return NextResponse.json({ error: revokeResult.error }, { status: 400 });
      }

      const idx = mockProposals.findIndex((p) => p.id === Number(proposalId));
      if (idx !== -1) {
        mockProposals[idx] = revokeResult.proposal;
      }
      updateMultisigProposalsLists();

      return NextResponse.json(
        {
          message: `Signature revoked for proposal #${proposalId}.`,
          proposal: revokeResult.proposal,
          data: mockTreasuryState,
        },
        { status: 200 }
      );
    }

    // ── 4. Execute Approved Multisig Proposal ──────────────────────────────────
    if (action === "execute") {
      const targetProposal = mockProposals.find((p) => p.id === Number(proposalId));
      if (!targetProposal) {
        return NextResponse.json({ error: `Proposal #${proposalId} not found.` }, { status: 404 });
      }

      const caller = signerAddress || DEFAULT_TREASURY_SIGNERS[0].address;
      const execResult = executeMultisigProposal(targetProposal, caller);

      if (!execResult.success) {
        return NextResponse.json({ error: execResult.error }, { status: 400 });
      }

      // Apply on-chain treasury effect based on action
      const actionDetails = targetProposal.action;
      if (actionDetails.type === "distribute") {
        const balanceToDistribute = actionDetails.amount || mockTreasuryState.currentBalance;
        const insurancePayout = (balanceToDistribute * (actionDetails.insuranceShareBps || 5000)) / 10000;
        const daoPayout = balanceToDistribute - insurancePayout;

        mockTreasuryState.totalDistributedInsurance += insurancePayout;
        mockTreasuryState.totalDistributedDao += daoPayout;
        mockTreasuryState.currentBalance = Math.max(0, mockTreasuryState.currentBalance - balanceToDistribute);

        const newHistoryItem: DistributionHistoryItem = {
          id: mockTreasuryState.history.length + 1,
          timestamp: new Date().toISOString(),
          asset: actionDetails.asset || mockTreasuryState.asset,
          insuranceAmount: insurancePayout,
          daoAmount: daoPayout,
          status: "Completed",
          txHash: execResult.proposal.txHash || "0x9a8f...c12",
          signaturesCount: targetProposal.approvals.length,
          approvedBy: targetProposal.approvals,
        };
        mockTreasuryState.history.unshift(newHistoryItem);
      } else if (actionDetails.type === "collect_fees") {
        const collectAmount = actionDetails.amount || 2500;
        mockTreasuryState.currentBalance += collectAmount;
        mockTreasuryState.totalCollected += collectAmount;
      }

      const idx = mockProposals.findIndex((p) => p.id === Number(proposalId));
      if (idx !== -1) {
        mockProposals[idx] = execResult.proposal;
      }
      updateMultisigProposalsLists();

      return NextResponse.json(
        {
          message: `Multi-sig proposal #${proposalId} executed successfully with ${targetProposal.approvals.length} signatures.`,
          proposal: execResult.proposal,
          data: mockTreasuryState,
        },
        { status: 200 }
      );
    }

    // ── 5. Direct Action Handlers (Create proposal or instant if authorized) ────
    if (action === "collect") {
      const collectAmount = amount || 2500;
      mockTreasuryState.currentBalance += collectAmount;
      mockTreasuryState.totalCollected += collectAmount;

      return NextResponse.json(
        {
          message: `Collected ${collectAmount} ${mockTreasuryState.asset} in protocol fees into Treasury.`,
          data: mockTreasuryState,
        },
        { status: 200 }
      );
    }

    if (action === "distribute") {
      const balanceToDistribute = mockTreasuryState.currentBalance;
      if (balanceToDistribute <= 0) {
        return NextResponse.json(
          { error: "Treasury balance is zero. Nothing to distribute." },
          { status: 400 }
        );
      }

      const insurancePayout = (balanceToDistribute * mockTreasuryState.rules.insuranceShareBps) / 10000;
      const daoPayout = balanceToDistribute - insurancePayout;

      mockTreasuryState.totalDistributedInsurance += insurancePayout;
      mockTreasuryState.totalDistributedDao += daoPayout;
      mockTreasuryState.currentBalance = 0;

      const newHistoryItem: DistributionHistoryItem = {
        id: mockTreasuryState.history.length + 1,
        timestamp: new Date().toISOString(),
        asset: mockTreasuryState.asset,
        insuranceAmount: insurancePayout,
        daoAmount: daoPayout,
        status: "Completed",
        txHash: `0x${Math.random().toString(16).substring(2, 10)}...${Math.random().toString(16).substring(2, 5)}`,
        signaturesCount: 3,
        approvedBy: [
          DEFAULT_TREASURY_SIGNERS[0].address,
          DEFAULT_TREASURY_SIGNERS[1].address,
          DEFAULT_TREASURY_SIGNERS[2].address,
        ],
      };

      mockTreasuryState.history.unshift(newHistoryItem);

      return NextResponse.json(
        {
          message: `Distributed ${balanceToDistribute} ${mockTreasuryState.asset} (50% Insurance / 50% DAO) via 3-of-5 Multi-Sig.`,
          data: mockTreasuryState,
        },
        { status: 200 }
      );
    }

    return NextResponse.json({ error: "Invalid action specified" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

