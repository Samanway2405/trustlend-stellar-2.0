/**
 * lib/stellar/sep31.ts
 *
 * Standard SEP-31 client for cross-border fiat-to-crypto deposits.
 * Integrates SEP-1 (toml), SEP-10 (auth), SEP-12 (KYC), and SEP-31 (direct payment) flows.
 */

import { signTransactionWithWallet, type StellarWalletProvider } from "@/lib/stellar/wallet";

export interface Sep31AnchorEndpoints {
  directPaymentServer: string;
  webAuthEndpoint: string;
  signingKey: string;
  kycServer: string;
}

export interface Sep31AssetInfo {
  enabled: boolean;
  min_amount?: number;
  max_amount?: number;
  sender_sep12_type?: string;
  receiver_sep12_type?: string;
  fields?: {
    transaction?: Record<string, { description: string; optional: boolean }>;
  };
}

export interface Sep31InfoResponse {
  receive: Record<string, Sep31AssetInfo>;
}

export interface Sep12CustomerStatus {
  id: string;
  status: "ACCEPTED" | "NEEDS_INFO" | "PROCESSING" | "REJECTED";
  fields?: Record<string, unknown>;
  provided_fields?: Record<string, unknown>;
}

export interface Sep31TransactionResponse {
  id: string;
  stellar_account_id?: string;
  stellar_memo_type?: string;
  stellar_memo?: string;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  how_to_register?: string;
  fields?: {
    info?: Record<string, string>;
  };
}

export type Sep31TxStatus =
  | "pending_sender"
  | "pending_stellar"
  | "pending_customer_info_update"
  | "pending_transaction_info_update"
  | "completed"
  | "error"
  | "refunded"
  | "hold";

export interface Sep31Transaction {
  id: string;
  status: Sep31TxStatus;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  stellar_transaction_id?: string;
  message?: string;
  refunded?: boolean;
}

// ─── TOML parsing (similar to sep24.ts) ──────────────────────────────────────────

function parseToml(toml: string): Record<string, string> {
  const top: Record<string, string> = {};
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("[")) continue; // skip tables for simple values

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");

    top[key] = value;
  }
  return top;
}

// ─── 1. Discover Anchor Endpoints ───────────────────────────────────────────────

export async function discoverSep31Anchor(homeDomain: string): Promise<Sep31AnchorEndpoints> {
  const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`;
  const res = await fetch(tomlUrl, { headers: { Accept: "text/plain" } });
  if (!res.ok) {
    throw new Error(`Could not load anchor stellar.toml from ${tomlUrl} (${res.status}).`);
  }
  const top = parseToml(await res.text());

  const directPaymentServer = top.DIRECT_PAYMENT_SERVER || top.DIRECT_PAYMENT_SERVER_SEP0031;
  const webAuthEndpoint = top.WEB_AUTH_ENDPOINT;
  const signingKey = top.SIGNING_KEY;
  const kycServer = top.KYC_SERVER || directPaymentServer;

  if (!directPaymentServer) {
    throw new Error("Anchor does not support SEP-31 (DIRECT_PAYMENT_SERVER missing).");
  }
  if (!webAuthEndpoint || !signingKey) {
    throw new Error("Anchor missing WEB_AUTH_ENDPOINT or SIGNING_KEY for authentication.");
  }

  return {
    directPaymentServer: directPaymentServer.replace(/\/$/, ""),
    webAuthEndpoint: webAuthEndpoint.replace(/\/$/, ""),
    signingKey,
    kycServer: kycServer ? kycServer.replace(/\/$/, "") : "",
  };
}

// ─── 2. SEP-10 Authentication ──────────────────────────────────────────────────

export async function authenticateSep31(
  endpoints: Sep31AnchorEndpoints,
  account: string,
  options: { provider?: StellarWalletProvider; homeDomain: string; networkPassphrase?: string }
): Promise<string> {
  // Get challenge transaction
  const challengeRes = await fetch(
    `${endpoints.webAuthEndpoint}?account=${encodeURIComponent(account)}&home_domain=${encodeURIComponent(options.homeDomain)}`
  );
  if (!challengeRes.ok) {
    throw new Error(`SEP-10 challenge request failed: ${challengeRes.status}`);
  }
  const challenge = (await challengeRes.json()) as { transaction?: string; network_passphrase?: string; error?: string };
  if (challenge.error || !challenge.transaction) {
    throw new Error(`Challenge error: ${challenge.error ?? "no transaction returned"}`);
  }

  // Sign challenge
  const passphrase = challenge.network_passphrase ?? options.networkPassphrase ?? "Test SDF Network ; September 2015";
  const signed = await signTransactionWithWallet({
    xdr: challenge.transaction,
    networkPassphrase: passphrase,
    address: account,
    provider: options.provider,
  });

  // Exchange for JWT
  const tokenRes = await fetch(endpoints.webAuthEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signed.signedTxXdr }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status}`);
  }
  const tokenJson = (await tokenRes.json()) as { token?: string; error?: string };
  if (tokenJson.error || !tokenJson.token) {
    throw new Error(`Token response error: ${tokenJson.error ?? "no token returned"}`);
  }

  return tokenJson.token;
}

// ─── 3. GET /info ─────────────────────────────────────────────────────────────

export async function getSep31Info(directPaymentServer: string): Promise<Sep31InfoResponse> {
  const res = await fetch(`${directPaymentServer}/info`);
  if (!res.ok) {
    throw new Error(`Failed to fetch SEP-31 info: ${res.status}`);
  }
  return res.json() as Promise<Sep31InfoResponse>;
}

// ─── 4. SEP-12 Customer Info Integration ────────────────────────────────────────

export async function getSep12Customer(
  kycServer: string,
  jwt: string,
  params: { id?: string; type?: string } = {}
): Promise<Sep12CustomerStatus> {
  const query = new URLSearchParams();
  if (params.id) query.append("id", params.id);
  if (params.type) query.append("type", params.type);

  const res = await fetch(`${kycServer}/customer?${query.toString()}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new Error(`GET /customer failed: ${res.status}`);
  }
  return res.json() as Promise<Sep12CustomerStatus>;
}

export async function registerSep12Customer(
  kycServer: string,
  jwt: string,
  details: Record<string, string | Blob> & { type?: string }
): Promise<string> {
  const formData = new FormData();
  for (const [key, val] of Object.entries(details)) {
    if (val !== undefined && val !== null) {
      formData.append(key, val);
    }
  }

  const res = await fetch(`${kycServer}/customer`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`PUT /customer failed (${res.status}): ${errorText}`);
  }

  const json = (await res.json()) as { id: string };
  return json.id;
}

// ─── 5. Create Direct Payment Transaction (SEP-31) ──────────────────────────────────

export async function createSep31Transaction(
  directPaymentServer: string,
  jwt: string,
  params: {
    amount: string;
    asset_code: string;
    asset_issuer?: string;
    sender_id: string;
    receiver_id: string;
    fields: Record<string, Record<string, string>>;
    callback?: string;
  }
): Promise<Sep31TransactionResponse> {
  const res = await fetch(`${directPaymentServer}/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const errorJson = await res.json().catch(() => null);
    throw new Error(`POST /transactions failed (${res.status}): ${errorJson?.error ?? "Unknown error"}`);
  }

  return res.json() as Promise<Sep31TransactionResponse>;
}

// ─── 6. GET transaction details ─────────────────────────────────────────────────

export async function getSep31Transaction(
  directPaymentServer: string,
  jwt: string,
  id: string
): Promise<Sep31Transaction> {
  const res = await fetch(`${directPaymentServer}/transactions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new Error(`GET transaction failed: ${res.status}`);
  }
  const json = (await res.json()) as { transaction: Sep31Transaction };
  return json.transaction;
}

// ─── 7. Webhook Signature Verification ──────────────────────────────────────────

/**
 * Verify Ed25519 signature on anchor callback webhook payloads using Ed25519.
 * Compatible with standard Stellar SDK signature verification.
 */
export async function verifyAnchorSignature(
  rawBody: string,
  signatureBase64: string,
  anchorSigningKey: string
): Promise<boolean> {
  try {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const keypair = Keypair.fromPublicKey(anchorSigningKey);
    const signatureBuffer = Buffer.from(signatureBase64, "base64");
    const payloadBuffer = Buffer.from(rawBody, "utf-8");
    return keypair.verify(payloadBuffer, signatureBuffer);
  } catch (err) {
    console.error("Signature verification failed with error:", err);
    return false;
  }
}
