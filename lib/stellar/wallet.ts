"use client";

import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { WalletConnectModule } from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
// The kit expects its own Networks enum for some methods, which has identical values to stellar-sdk
import { Networks as KitNetworks } from "@creit.tech/stellar-wallets-kit/types";

export type StellarWalletProvider = "freighter" | "albedo" | "walletconnect" | "xbull";

export interface ConnectedWallet {
  provider: StellarWalletProvider;
  address: string;
}

export interface SignTransactionParams {
  xdr: string;
  networkPassphrase: string;
  address?: string;
  provider?: StellarWalletProvider;
}

const WALLET_PROVIDER_STORAGE_KEY = "wallet_provider";
const WALLET_ADDRESS_STORAGE_KEY = "wallet_address";

export function getWalletProviderLabel(provider: StellarWalletProvider): string {
  if (provider === "albedo") return "Albedo";
  if (provider === "walletconnect") return "WalletConnect";
  if (provider === "xbull") return "xBull";
  return "Freighter";
}

export function getStoredWalletProvider(): StellarWalletProvider | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(WALLET_PROVIDER_STORAGE_KEY);
  if (stored === "albedo" || stored === "walletconnect" || stored === "xbull" || stored === "freighter") {
    return stored as StellarWalletProvider;
  }
  return null;
}

export function setStoredWalletProvider(provider: StellarWalletProvider | null) {
  if (typeof window === "undefined") return;
  if (!provider) {
    window.localStorage.removeItem(WALLET_PROVIDER_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, provider);
}

let kitInitialized = false;

function ensureKit(): void {
  if (typeof window === "undefined") {
    throw new Error("StellarWalletsKit can only be initialized in the browser.");
  }
  
  if (!kitInitialized) {
    const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "16e6f0cf5c4b78c66a4f9103de534d02"; // Standard placeholder for testing
    
    StellarWalletsKit.init({
      network: KitNetworks.TESTNET,
      modules: [
        new FreighterModule(),
        new AlbedoModule(),
        new xBullModule(),
        new WalletConnectModule({
          projectId,
          metadata: {
            name: "TrustLend",
            description: "TrustLend - P2P Lending on Stellar",
            url: window.location.origin,
            icons: ["https://stellar.org/favicon.ico"]
          }
        })
      ]
    });
    kitInitialized = true;
  }
}

function mapProviderToModuleId(provider: StellarWalletProvider): string {
  switch (provider) {
    case "freighter": return "freighter";
    case "albedo": return "albedo";
    case "walletconnect": return "walletconnect"; 
    case "xbull": return "xbull";
  }
}

export async function connectWallet(provider?: StellarWalletProvider | null): Promise<ConnectedWallet> {
  ensureKit();
  
  if (provider) {
    const moduleId = mapProviderToModuleId(provider);
    StellarWalletsKit.setWallet(moduleId);
    
    const { address } = await StellarWalletsKit.getAddress();
    
    if (!address) {
      throw new Error(`Failed to get address from ${getWalletProviderLabel(provider)}.`);
    }

    setStoredWalletProvider(provider);
    window.localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, address);
    return { provider, address };
  } else {
    // If no provider specified, let the user choose via the kit's modal
    const result = await StellarWalletsKit.authModal();
    if (!result || !result.address) {
      throw new Error("Wallet connection was cancelled or failed.");
    }
    
    // The kit sets the selected module after authModal finishes successfully
    let selectedProvider: StellarWalletProvider = "freighter"; // fallback
    try {
      selectedProvider = StellarWalletsKit.selectedModule?.productId as StellarWalletProvider;
    } catch (e) {
      // Ignore if selectedModule getter throws
    }
    
    setStoredWalletProvider(selectedProvider);
    window.localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, result.address);
    return { provider: selectedProvider, address: result.address };
  }
}

export async function getConnectedWallet(provider?: StellarWalletProvider): Promise<ConnectedWallet> {
  const selectedProvider = provider ?? getStoredWalletProvider();
  
  if (typeof window !== "undefined" && selectedProvider) {
    const storedAddress = window.localStorage.getItem(WALLET_ADDRESS_STORAGE_KEY);
    if (storedAddress) {
       // Just silently set the kit's active module
       try {
         ensureKit();
         StellarWalletsKit.setWallet(mapProviderToModuleId(selectedProvider));
       } catch (e) {
         console.warn("Failed to silently set wallet kit module", e);
       }
       return { provider: selectedProvider, address: storedAddress };
    }
  }

  // If no stored address or no selected provider, attempt to connect (will show modal if selectedProvider is null)
  return connectWallet(selectedProvider);
}

export async function signTransactionWithWallet({
  xdr,
  networkPassphrase,
  address,
  provider,
}: SignTransactionParams): Promise<{
  signedTxXdr: string;
  signerAddress?: string;
  provider: StellarWalletProvider;
}> {
  const selectedProvider = provider ?? getStoredWalletProvider();
  ensureKit();
  
  if (selectedProvider) {
    StellarWalletsKit.setWallet(mapProviderToModuleId(selectedProvider));
  }

  // The kit expects options to be passed
  const { signedTxXdr, signerAddress } = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase,
    address,
  });

  return {
    signedTxXdr,
    signerAddress,
    provider: selectedProvider || ("freighter" as StellarWalletProvider),
  };
}
