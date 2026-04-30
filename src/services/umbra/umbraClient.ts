import {
  getEncryptedBalanceQuerierFunction,
  getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
  getPublicBalanceToEncryptedBalanceDirectDepositorFunction,
  getUmbraClient,
  getUserRegistrationFunction,
  type DepositResult,
  type GetUmbraClientDeps,
  type WithdrawResult,
} from "@umbra-privacy/sdk";
import type { QueryEncryptedBalanceResult } from "@umbra-privacy/sdk/interfaces";
import type { U64 } from "@umbra-privacy/sdk/types";
import type { NetworkId } from "@/lib/constants";
import type { UmbraTokenBalanceRecord } from "@/types";
import { createUmbraMasterSeedStorage } from "./umbraMasterSeedStorage";
import {
  getUmbraClientNetworkConfig,
  getUmbraTokens,
  type UmbraTokenConfig,
} from "./umbraConfig";
import { createVaulkyrieUmbraSigner } from "./vaulkyrieUmbraSigner";

const ARCIUM_FINALIZATION = {
  reclaimComputationRent: false,
  safetyTimeoutMs: 120_000,
} as const;

export interface UmbraWalletClient {
  registerConfidential: () => Promise<string[]>;
  queryBalances: (tokens?: UmbraTokenConfig[]) => Promise<UmbraTokenBalanceRecord[]>;
  deposit: (params: UmbraTransferParams) => Promise<DepositResult>;
  withdraw: (params: UmbraTransferParams) => Promise<WithdrawResult>;
}

export interface UmbraTransferParams {
  destinationAddress?: string;
  mint: string;
  amountAtomic: bigint;
}

export async function createUmbraWalletClient(
  walletPublicKey: string,
  network: NetworkId,
): Promise<UmbraWalletClient> {
  const config = getUmbraClientNetworkConfig(network);
  const signer = createVaulkyrieUmbraSigner(walletPublicKey);
  const deps: GetUmbraClientDeps = {
    masterSeedStorage: createUmbraMasterSeedStorage(walletPublicKey, config.network),
  };
  const client = await getUmbraClient(
    {
      signer,
      network: config.network,
      rpcUrl: config.rpcUrl,
      rpcSubscriptionsUrl: config.rpcSubscriptionsUrl,
      deferMasterSeedSignature: true,
    },
    deps,
  );

  return {
    async registerConfidential() {
      const registerUser = getUserRegistrationFunction({ client });
      return registerUser({ confidential: true, anonymous: false });
    },
    async queryBalances(tokens = getUmbraTokens(network)) {
      const query = getEncryptedBalanceQuerierFunction({ client });
      const results = await query(tokens.map((token) => token.mint as never));
      return tokens.map((token) => normalizeBalance(token, results.get(token.mint as never)));
    },
    async deposit({ destinationAddress = walletPublicKey, mint, amountAtomic }) {
      const deposit = getPublicBalanceToEncryptedBalanceDirectDepositorFunction(
        { client },
        { arcium: { awaitComputationFinalization: ARCIUM_FINALIZATION } },
      );
      return deposit(destinationAddress as never, mint as never, amountAtomic as U64);
    },
    async withdraw({ destinationAddress = walletPublicKey, mint, amountAtomic }) {
      const withdraw = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction(
        { client },
        { arcium: { awaitComputationFinalization: ARCIUM_FINALIZATION } },
      );
      return withdraw(destinationAddress as never, mint as never, amountAtomic as U64);
    },
  };
}

function normalizeBalance(
  token: UmbraTokenConfig,
  result: QueryEncryptedBalanceResult | undefined,
): UmbraTokenBalanceRecord {
  const now = Date.now();
  if (!result) {
    return {
      mint: token.mint,
      symbol: token.symbol,
      decimals: token.decimals,
      state: "unknown",
      updatedAt: now,
    };
  }

  if (result.state !== "shared") {
    return {
      mint: token.mint,
      symbol: token.symbol,
      decimals: token.decimals,
      state: result.state,
      updatedAt: now,
    };
  }

  const balanceAtomic = result.balance.toString();
  return {
    mint: token.mint,
    symbol: token.symbol,
    decimals: token.decimals,
    state: "shared",
    balanceAtomic,
    balanceUi: formatAtomicAmount(BigInt(balanceAtomic), token.decimals),
    updatedAt: now,
  };
}

export function parseUiAmount(value: string, decimals: number): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("Enter a valid amount.");
  }

  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Amount supports up to ${decimals} decimals.`);
  }

  const paddedFraction = fraction.padEnd(decimals, "0");
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFraction || "0");
  if (amount <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  return amount;
}

export function formatAtomicAmount(amount: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  if (fraction === 0n) {
    return whole.toString();
  }

  return `${whole.toString()}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}
