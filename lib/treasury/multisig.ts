/**
 * lib/treasury/multisig.ts
 *
 * Multi-Signature Treasury Support (Issue #257).
 * Ensures platform treasury operations require 3 of 5 admin signatures.
 */

export interface TreasurySigner {
  address: string;
  name: string;
  role: string;
  isActive: boolean;
}

export type TreasuryActionType =
  | "distribute"
  | "collect_fees"
  | "transfer"
  | "set_rules";

export interface TreasuryActionDistribute {
  type: "distribute";
  asset: string;
  amount: number;
  insuranceShareBps: number;
  daoShareBps: number;
}

export interface TreasuryActionCollectFees {
  type: "collect_fees";
  asset: string;
  amount: number;
}

export interface TreasuryActionTransfer {
  type: "transfer";
  asset: string;
  amount: number;
  recipient: string;
  memo?: string;
}

export interface TreasuryActionSetRules {
  type: "set_rules";
  insuranceShareBps: number;
  daoShareBps: number;
}

export type TreasuryProposalAction =
  | TreasuryActionDistribute
  | TreasuryActionCollectFees
  | TreasuryActionTransfer
  | TreasuryActionSetRules;

export interface TreasuryMultisigProposal {
  id: number;
  title: string;
  description: string;
  action: TreasuryProposalAction;
  proposer: string;
  proposerName?: string;
  approvals: string[]; // List of signer addresses that have signed
  threshold: number; // 3
  totalSigners: number; // 5
  status: "pending" | "ready" | "executed" | "cancelled";
  createdAt: string;
  executedAt?: string | null;
  executedBy?: string | null;
  txHash?: string | null;
}

export const TREASURY_THRESHOLD = 3;
export const TREASURY_SIGNERS_COUNT = 5;

export const DEFAULT_TREASURY_SIGNERS: TreasurySigner[] = [
  {
    address: "GBADMIN1TREASURY7K2V9X3P4Q8M1N6L5W0J4H7G2D8F9S1A3K5Z7",
    name: "Treasury Lead (Admin 1)",
    role: "Protocol Custodian",
    isActive: true,
  },
  {
    address: "GBADMIN2SECURITY4M7P9Q1X3V5L8W0J2H6G4D7F9S1A3K5Z8",
    name: "Security Admin (Admin 2)",
    role: "Risk & Security Officer",
    isActive: true,
  },
  {
    address: "GBADMIN3GOVERNANCE8N1Q3X5V7L9W0J2H4G6D8F1S3A5K7Z9",
    name: "DAO Representative (Admin 3)",
    role: "Governance Delegate",
    isActive: true,
  },
  {
    address: "GBADMIN4AUDIT9P1X3V5L7W0J2H4G6D8F1S3A5K7Z9Q2W4E6",
    name: "Financial Controller (Admin 4)",
    role: "Audit & Compliance",
    isActive: true,
  },
  {
    address: "GBADMIN5OPERATIONS2X4V6L8W0J2H4G6D8F1S3A5K7Z9Q3E5",
    name: "Core Ops Admin (Admin 5)",
    role: "Platform Operations",
    isActive: true,
  },
];

/**
 * Checks if a given wallet address is one of the authorized treasury signers.
 */
export function isAuthorizedSigner(
  address: string,
  signers: TreasurySigner[] = DEFAULT_TREASURY_SIGNERS
): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  return signers.some(
    (s) => s.isActive && s.address.toLowerCase() === normalized
  );
}

/**
 * Checks if a proposal has gathered enough signatures to be executed (>= 3 of 5).
 */
export function canExecuteProposal(
  proposal: TreasuryMultisigProposal,
  threshold: number = TREASURY_THRESHOLD
): boolean {
  if (proposal.status === "executed" || proposal.status === "cancelled") {
    return false;
  }
  return proposal.approvals.length >= threshold;
}

/**
 * Creates a new multisig proposal with the proposer's signature automatically recorded.
 */
export function createMultisigProposal(params: {
  id: number;
  title: string;
  description: string;
  action: TreasuryProposalAction;
  proposerAddress: string;
  proposerName?: string;
  signers?: TreasurySigner[];
  threshold?: number;
}): TreasuryMultisigProposal {
  const threshold = params.threshold ?? TREASURY_THRESHOLD;
  const totalSigners = params.signers?.length ?? TREASURY_SIGNERS_COUNT;
  const approvals = [params.proposerAddress];
  const isReady = approvals.length >= threshold;

  return {
    id: params.id,
    title: params.title,
    description: params.description,
    action: params.action,
    proposer: params.proposerAddress,
    proposerName: params.proposerName,
    approvals,
    threshold,
    totalSigners,
    status: isReady ? "ready" : "pending",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Adds a signature from an authorized admin to an active proposal.
 */
export function signMultisigProposal(
  proposal: TreasuryMultisigProposal,
  signerAddress: string,
  signers: TreasurySigner[] = DEFAULT_TREASURY_SIGNERS
): { success: boolean; proposal: TreasuryMultisigProposal; error?: string } {
  if (proposal.status === "executed" || proposal.status === "cancelled") {
    return { success: false, proposal, error: `Proposal is already ${proposal.status}.` };
  }

  if (!isAuthorizedSigner(signerAddress, signers)) {
    return { success: false, proposal, error: "Address is not an authorized treasury signer." };
  }

  const normalized = signerAddress.trim();
  const alreadySigned = proposal.approvals.some(
    (a) => a.toLowerCase() === normalized.toLowerCase()
  );

  if (alreadySigned) {
    return { success: false, proposal, error: "Signer has already approved this proposal." };
  }

  const updatedApprovals = [...proposal.approvals, normalized];
  const isReady = updatedApprovals.length >= proposal.threshold;

  const updatedProposal: TreasuryMultisigProposal = {
    ...proposal,
    approvals: updatedApprovals,
    status: isReady ? "ready" : "pending",
  };

  return { success: true, proposal: updatedProposal };
}

/**
 * Revokes a previously added signature from a proposal before execution.
 */
export function revokeProposalSignature(
  proposal: TreasuryMultisigProposal,
  signerAddress: string
): { success: boolean; proposal: TreasuryMultisigProposal; error?: string } {
  if (proposal.status === "executed" || proposal.status === "cancelled") {
    return { success: false, proposal, error: `Cannot revoke: Proposal is ${proposal.status}.` };
  }

  const normalized = signerAddress.trim().toLowerCase();
  const index = proposal.approvals.findIndex((a) => a.toLowerCase() === normalized);

  if (index === -1) {
    return { success: false, proposal, error: "Signer has not approved this proposal." };
  }

  const updatedApprovals = proposal.approvals.filter(
    (a) => a.toLowerCase() !== normalized
  );
  const isReady = updatedApprovals.length >= proposal.threshold;

  const updatedProposal: TreasuryMultisigProposal = {
    ...proposal,
    approvals: updatedApprovals,
    status: isReady ? "ready" : "pending",
  };

  return { success: true, proposal: updatedProposal };
}

/**
 * Executes a proposal once the 3 of 5 signature threshold is satisfied.
 */
export function executeMultisigProposal(
  proposal: TreasuryMultisigProposal,
  callerAddress: string,
  txHash?: string
): { success: boolean; proposal: TreasuryMultisigProposal; error?: string } {
  if (proposal.status === "executed") {
    return { success: false, proposal, error: "Proposal is already executed." };
  }
  if (proposal.status === "cancelled") {
    return { success: false, proposal, error: "Proposal was cancelled." };
  }
  if (proposal.approvals.length < proposal.threshold) {
    return {
      success: false,
      proposal,
      error: `Insufficient signatures: Requires ${proposal.threshold} of ${proposal.totalSigners} signatures, but only ${proposal.approvals.length} provided.`,
    };
  }

  const executedTxHash =
    txHash ||
    `0x${Math.random().toString(16).substring(2, 10)}${Math.random().toString(16).substring(2, 10)}`;

  const updatedProposal: TreasuryMultisigProposal = {
    ...proposal,
    status: "executed",
    executedAt: new Date().toISOString(),
    executedBy: callerAddress,
    txHash: executedTxHash,
  };

  return { success: true, proposal: updatedProposal };
}
