import {
  getDefaultMasterSeedGenerator,
  getClaimableUtxoScannerFunction,
  getEncryptedBalanceQuerierFunction,
  getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
  getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction,
  getMasterViewingKeyBlindingFactorDeriver,
  getMasterViewingKeyDeriver,
  getMasterViewingKeyX25519KeypairDeriver,
  getPoseidonBlindingFactorDeriver,
  getPoseidonPrivateKeyDeriver,
  getPublicBalanceToEncryptedBalanceDirectDepositorFunction,
  getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
  getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
  getUmbraClient,
  getUmbraRelayer,
  getUserAccountX25519KeypairDeriver,
  getUserAccountQuerierFunction,
  getUserCommitmentGeneratorFunction,
  getUserRegistrationFunction,
  type DepositResult,
  type GetUmbraClientDeps,
  type MasterSeed,
  type WithdrawResult,
} from "@umbra-privacy/sdk";
import { decodeEncryptedUserAccount } from "@umbra-privacy/umbra-codama";
import type {
  ClaimUtxoIntoEncryptedBalanceResult,
  CreateUtxoFromEncryptedBalanceResult,
  CreateUtxoFromPublicBalanceResult,
  ScannedUtxoData,
  ScannedUtxoResult,
  QueryEncryptedBalanceResult,
} from "@umbra-privacy/sdk/interfaces";
import type { U64 } from "@umbra-privacy/sdk/types";
import { createSignerFromPrivateKeyBytes } from "@umbra-privacy/sdk";
import { getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import type { NetworkId } from "@/lib/constants";
import { getWalletAccountKind } from "@/lib/walletAccounts";
import { readWalletPersistedEnvelope, WALLET_STORAGE_KEY } from "@/lib/walletPersistStorage";
import {
  invokeUmbraOperationInBackground,
} from "@/lib/internalWalletRpc";
import type { UmbraTokenBalanceRecord } from "@/types";
import type { PersistedWalletState } from "@/store/walletStore";
import { createBackgroundUmbraMasterSeedStorage } from "./umbraMasterSeedStorage";
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
const MAX_U64 = (1n << 64n) - 1n;

const CLAIM_SCAN_TREE = 0n as never;
const CLAIM_SCAN_START = 0n as never;

function isBackgroundContext(): boolean {
  return typeof window === "undefined";
}

async function loadPrivacyVaultSecretKeyForDirectUmbraClient(walletPublicKey: string): Promise<Uint8Array> {
  const { loadPrivacyVaultSecretKeyInBackground } = await import("@/background/vaultSession");
  return loadPrivacyVaultSecretKeyInBackground(walletPublicKey);
}

async function loadUmbraMasterSeedForDirectUmbraClient(walletPublicKey: string, network: string) {
  const { loadUmbraMasterSeedInBackground } = await import("@/background/vaultSession");
  return loadUmbraMasterSeedInBackground(walletPublicKey, network as never);
}

async function storeUmbraMasterSeedForDirectUmbraClient(
  walletPublicKey: string,
  network: string,
  seed: Uint8Array,
): Promise<void> {
  const { storeUmbraMasterSeedInBackground } = await import("@/background/vaultSession");
  return storeUmbraMasterSeedInBackground(walletPublicKey, network as never, seed);
}

interface ResolvedSeedState {
  storage: NonNullable<GetUmbraClientDeps["masterSeedStorage"]>;
  seedIssueMessage?: string;
}

type UmbraSignerLike = Awaited<ReturnType<typeof createSignerFromPrivateKeyBytes>>;
const EMPTY_MASTER_SEED = new Uint8Array(64) as unknown as MasterSeed;
const ENCRYPTED_USER_ACCOUNT_SEED = sha256(new TextEncoder().encode("EncryptedUserAccount"));
const STATUS_BIT_USER_COMMITMENT_REGISTERED = 1n << 2n;
const STATUS_BIT_USER_ACCOUNT_X25519_PUBKEY_REGISTERED = 1n << 4n;

interface UmbraOnChainIdentityState {
  exists: boolean;
  isUserAccountX25519KeyRegistered: boolean;
  isUserCommitmentRegistered: boolean;
  tokenX25519PublicKey: Uint8Array | null;
  masterViewingKeyX25519PublicKey: Uint8Array | null;
  userCommitment: bigint | null;
}

interface UmbraSeedValidationResult {
  score: 0 | 1 | 2;
}

export interface UmbraWalletClient {
  registerConfidential: () => Promise<string[]>;
  queryAccountState: (address?: string) => Promise<UmbraRegistrationState>;
  queryBalances: (tokens?: UmbraTokenConfig[]) => Promise<UmbraTokenBalanceRecord[]>;
  deposit: (params: UmbraTransferParams) => Promise<DepositResult>;
  withdraw: (params: UmbraTransferParams) => Promise<WithdrawResult>;
  privateSendFromEncryptedBalance: (params: UmbraPrivateSendParams) => Promise<CreateUtxoFromEncryptedBalanceResult>;
  privateSendFromPublicBalance: (params: UmbraPrivateSendParams) => Promise<CreateUtxoFromPublicBalanceResult>;
  scanIncomingUtxos: (startIndex?: number) => Promise<UmbraIncomingUtxos>;
  claimIncomingToEncryptedBalance: (utxos: readonly ScannedUtxoData[]) => Promise<ClaimUtxoIntoEncryptedBalanceResult>;
}

export interface UmbraTransferParams {
  destinationAddress?: string;
  mint: string;
  amountAtomic: bigint;
}

export interface UmbraPrivateSendParams {
  destinationAddress: string;
  mint: string;
  amountAtomic: bigint;
}

export interface UmbraIncomingUtxos {
  received: ScannedUtxoData[];
  publicReceived: ScannedUtxoData[];
  selfBurnable: ScannedUtxoData[];
  publicSelfBurnable: ScannedUtxoData[];
  nextScanStartIndex?: number;
}

export interface UmbraRegistrationState {
  exists: boolean;
  confidential: boolean;
  anonymous: boolean;
}

export async function createUmbraWalletClient(
  walletPublicKey: string,
  network: NetworkId,
): Promise<UmbraWalletClient> {
  if (!isBackgroundContext()) {
    return createBackgroundUmbraWalletClientProxy(walletPublicKey, network);
  }
  return createDirectUmbraWalletClient(walletPublicKey, network);
}

export async function createDirectUmbraWalletClient(
  walletPublicKey: string,
  network: NetworkId,
): Promise<UmbraWalletClient> {
  const config = getUmbraClientNetworkConfig(network);
  const envelope = await readWalletPersistedEnvelope<PersistedWalletState>(WALLET_STORAGE_KEY);
  const account = envelope?.state?.accounts.find((candidate) => candidate.publicKey === walletPublicKey);
  const isPrivacyVaultAccount = getWalletAccountKind(account) === "privacy-vault";
  const signer =
    isPrivacyVaultAccount
      ? await createSignerFromPrivateKeyBytes(await loadPrivacyVaultSecretKeyForDirectUmbraClient(walletPublicKey))
      : createVaulkyrieUmbraSigner(walletPublicKey);
  const resolvedSeedState = isPrivacyVaultAccount
    ? await resolvePrivacyVaultSeedState(walletPublicKey, signer, config)
    : await resolveThresholdSeedState(walletPublicKey, signer, config);
  const deps: GetUmbraClientDeps = {
    masterSeedStorage: resolvedSeedState.storage,
  };
  const client = await getUmbraClient(
    {
      signer,
      network: config.network,
      rpcUrl: config.rpcUrl,
      rpcSubscriptionsUrl: config.rpcSubscriptionsUrl,
      indexerApiEndpoint: config.indexerApiEndpoint,
      deferMasterSeedSignature: true,
    },
    deps,
  );
  const requireHealthySeed = () => {
    if (resolvedSeedState.seedIssueMessage) {
      throw new Error(resolvedSeedState.seedIssueMessage);
    }
  };

  return {
    async registerConfidential() {
      requireHealthySeed();
      const { getUserRegistrationProver } = await import("@umbra-privacy/web-zk-prover");
      const registerUser = getUserRegistrationFunction(
        { client },
        { zkProver: getUserRegistrationProver() },
      );
      return registerUser({ confidential: true, anonymous: true });
    },
    async queryAccountState(address = walletPublicKey) {
      const query = getUserAccountQuerierFunction({ client });
      const result = await query(address as never);
      if (result.state !== "exists") {
        return {
          exists: false,
          confidential: false,
          anonymous: false,
        };
      }

      return {
        exists: true,
        confidential: result.data.isUserAccountX25519KeyRegistered,
        anonymous: result.data.isUserCommitmentRegistered && result.data.isActiveForAnonymousUsage,
      };
    },
    async queryBalances(tokens = getUmbraTokens(network)) {
      if (resolvedSeedState.seedIssueMessage) {
        const now = Date.now();
        return tokens.map((token) => ({
          mint: token.mint,
          symbol: token.symbol,
          decimals: token.decimals,
          state: "error" as const,
          error: resolvedSeedState.seedIssueMessage,
          updatedAt: now,
        }));
      }
      const query = getEncryptedBalanceQuerierFunction({ client });
      const results = await query(tokens.map((token) => token.mint as never));
      return tokens.map((token) => normalizeBalance(token, results.get(token.mint as never)));
    },
    async deposit({ destinationAddress = walletPublicKey, mint, amountAtomic }) {
      requireHealthySeed();
      const deposit = getPublicBalanceToEncryptedBalanceDirectDepositorFunction(
        { client },
        { arcium: { awaitComputationFinalization: ARCIUM_FINALIZATION } },
      );
      return deposit(destinationAddress as never, mint as never, amountAtomic as U64);
    },
    async withdraw({ destinationAddress = walletPublicKey, mint, amountAtomic }) {
      requireHealthySeed();
      const withdraw = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction(
        { client },
        { arcium: { awaitComputationFinalization: ARCIUM_FINALIZATION } },
      );
      return withdraw(destinationAddress as never, mint as never, amountAtomic as U64);
    },
    async privateSendFromEncryptedBalance({ destinationAddress, mint, amountAtomic }) {
      requireHealthySeed();
      const { getCreateReceiverClaimableUtxoFromEncryptedBalanceProver } = await import(
        "@umbra-privacy/web-zk-prover"
      );
      const createUtxo = getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction(
        { client },
        {
          zkProver: getCreateReceiverClaimableUtxoFromEncryptedBalanceProver(),
          arcium: { awaitComputationFinalization: ARCIUM_FINALIZATION },
        },
      );
      return createUtxo({
        destinationAddress: destinationAddress as never,
        mint: mint as never,
        amount: amountAtomic as U64,
      });
    },
    async privateSendFromPublicBalance({ destinationAddress, mint, amountAtomic }) {
      requireHealthySeed();
      const { getCreateReceiverClaimableUtxoFromPublicBalanceProver } = await import(
        "@umbra-privacy/web-zk-prover"
      );
      const createUtxo = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
        { client },
        { zkProver: getCreateReceiverClaimableUtxoFromPublicBalanceProver() },
      );
      return createUtxo({
        destinationAddress: destinationAddress as never,
        mint: mint as never,
        amount: amountAtomic as U64,
      });
    },
    async scanIncomingUtxos(startIndex) {
      requireHealthySeed();
      if (!config.indexerApiEndpoint) {
        throw new Error("Umbra mixer scanning requires an indexer endpoint.");
      }
      const scan = getClaimableUtxoScannerFunction({ client });
      return normalizeScannedUtxos(await scan(CLAIM_SCAN_TREE, normalizeClaimScanStartIndex(startIndex)));
    },
    async claimIncomingToEncryptedBalance(utxos) {
      requireHealthySeed();
      if (!config.indexerApiEndpoint) {
        throw new Error("Umbra mixer claims require an indexer endpoint.");
      }
      if (!config.relayerApiEndpoint) {
        throw new Error("Umbra mixer claims require a relayer endpoint.");
      }
      if (!client.fetchBatchMerkleProof) {
        throw new Error("Umbra mixer claims require a batch Merkle proof fetcher.");
      }
      const { getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver } = await import(
        "@umbra-privacy/web-zk-prover"
      );
      const relayer = getUmbraRelayer({ apiEndpoint: config.relayerApiEndpoint });
      const claim = getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction(
        { client },
        {
          fetchBatchMerkleProof: client.fetchBatchMerkleProof,
          zkProver: getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver(),
          relayer,
          awaitCompletion: true,
          timeoutMs: 180_000,
        },
      );
      return claim(utxos);
    },
  };
}

async function resolvePrivacyVaultSeedState(
  walletPublicKey: string,
  signer: UmbraSignerLike,
  config: ReturnType<typeof getUmbraClientNetworkConfig>,
): Promise<ResolvedSeedState> {
  const deterministicGenerator = getDefaultMasterSeedGenerator(signer);
  const deterministicSeed = await deterministicGenerator();
  const storedSeed = await loadUmbraMasterSeedForDirectUmbraClient(walletPublicKey, config.network);
  const storedMasterSeed = storedSeed.exists ? toMasterSeed(storedSeed.seed) : null;
  const onChainIdentity = await loadUmbraOnChainIdentityState(walletPublicKey, signer, config);

  if (!onChainIdentity.exists || !onChainIdentity.isUserAccountX25519KeyRegistered) {
    await storeUmbraMasterSeedForDirectUmbraClient(walletPublicKey, config.network, deterministicSeed);
    return {
      storage: createFixedMasterSeedStorage(deterministicSeed, deterministicGenerator),
    };
  }

  const deterministicMatch = await evaluateSeedAgainstUmbraIdentity(deterministicSeed, signer, config, onChainIdentity);
  const storedMatch = storedMasterSeed
    ? await evaluateSeedAgainstUmbraIdentity(storedMasterSeed, signer, config, onChainIdentity)
    : { score: 0 as const };

  if (deterministicMatch.score >= storedMatch.score && deterministicMatch.score > 0) {
    if (!storedSeed.exists || !bytesEqual(storedSeed.seed, deterministicSeed)) {
      await storeUmbraMasterSeedForDirectUmbraClient(walletPublicKey, config.network, deterministicSeed);
    }
    return {
      storage: createFixedMasterSeedStorage(deterministicSeed, deterministicGenerator),
    };
  }

  if (storedMatch.score > 0 && storedMasterSeed) {
    return {
      storage: createFixedMasterSeedStorage(storedMasterSeed, deterministicGenerator),
    };
  }

  return {
    storage: createFixedMasterSeedStorage(deterministicSeed, deterministicGenerator),
    seedIssueMessage:
      "Umbra could not match this Privacy Vault to a valid local Umbra seed. The on-chain Umbra X25519 key does not match either the deterministic vault-derived seed or the stored legacy Umbra seed.",
  };
}

async function resolveThresholdSeedState(
  walletPublicKey: string,
  signer: UmbraSignerLike,
  config: ReturnType<typeof getUmbraClientNetworkConfig>,
): Promise<ResolvedSeedState> {
  const storage = createBackgroundUmbraMasterSeedStorage(walletPublicKey, config.network);
  const storedSeed = await loadUmbraMasterSeedForDirectUmbraClient(walletPublicKey, config.network);
  if (storedSeed.exists) {
    return { storage };
  }

  const onChainIdentity = await loadUmbraOnChainIdentityState(walletPublicKey, signer, config);
  if (onChainIdentity.exists) {
    return {
      storage,
      seedIssueMessage:
        "This threshold vault is already registered on Umbra, but its local Umbra seed is missing on this device. Vaulkyrie cannot decrypt balances or create private transfers for this vault without the original Umbra seed.",
    };
  }

  return { storage };
}

function createFixedMasterSeedStorage(
  seed: MasterSeed,
  generate?: () => Promise<MasterSeed>,
): NonNullable<GetUmbraClientDeps["masterSeedStorage"]> {
  return {
    load: async () => ({ exists: true as const, seed }),
    generate: async () => (generate ? generate() : seed),
    store: async () => ({ success: true }),
  };
}

async function loadUmbraOnChainIdentityState(
  walletPublicKey: string,
  signer: UmbraSignerLike,
  config: ReturnType<typeof getUmbraClientNetworkConfig>,
): Promise<UmbraOnChainIdentityState> {
  const probeClient = await getUmbraClient(
    {
      signer,
      network: config.network,
      rpcUrl: config.rpcUrl,
      rpcSubscriptionsUrl: config.rpcSubscriptionsUrl,
      indexerApiEndpoint: config.indexerApiEndpoint,
      deferMasterSeedSignature: true,
    },
    {
      masterSeedStorage: createFixedMasterSeedStorage(EMPTY_MASTER_SEED),
    },
  );
  const userAccountPda = await findEncryptedUserAccountPda(walletPublicKey, probeClient.networkConfig.programId);
  const accountMap = await probeClient.accountInfoProvider([userAccountPda as never], { commitment: "confirmed" });
  const maybeAccount = accountMap.get(userAccountPda as never);

  if (!maybeAccount?.exists) {
    return {
      exists: false,
      isUserAccountX25519KeyRegistered: false,
      isUserCommitmentRegistered: false,
      tokenX25519PublicKey: null,
      masterViewingKeyX25519PublicKey: null,
      userCommitment: null,
    };
  }

  const decodedAccount = decodeEncryptedUserAccount(maybeAccount);
  const statusBits = decodedAccount.data.statusBits.first;
  return {
    exists: true,
    isUserAccountX25519KeyRegistered: (statusBits & STATUS_BIT_USER_ACCOUNT_X25519_PUBKEY_REGISTERED) !== 0n,
    isUserCommitmentRegistered: (statusBits & STATUS_BIT_USER_COMMITMENT_REGISTERED) !== 0n,
    tokenX25519PublicKey: Uint8Array.from(decodedAccount.data.x25519PublicKeyForTokenEncryption.first),
    masterViewingKeyX25519PublicKey: Uint8Array.from(decodedAccount.data.x25519PublicKeyForMasterViewingKeyEncryption.first),
    userCommitment: bytesToBigIntLe(Uint8Array.from(decodedAccount.data.userCommitment.first)),
  };
}

async function evaluateSeedAgainstUmbraIdentity(
  seed: MasterSeed,
  signer: UmbraSignerLike,
  config: ReturnType<typeof getUmbraClientNetworkConfig>,
  onChainIdentity: UmbraOnChainIdentityState,
): Promise<UmbraSeedValidationResult> {
  const probeClient = await getUmbraClient(
    {
      signer,
      network: config.network,
      rpcUrl: config.rpcUrl,
      rpcSubscriptionsUrl: config.rpcSubscriptionsUrl,
      indexerApiEndpoint: config.indexerApiEndpoint,
      deferMasterSeedSignature: true,
    },
    {
      masterSeedStorage: createFixedMasterSeedStorage(seed),
    },
  );
  const deriveUserAccountX25519 = getUserAccountX25519KeypairDeriver({ client: probeClient });
  const userAccountKeypair = await deriveUserAccountX25519();
  const matchesTokenKey =
    onChainIdentity.tokenX25519PublicKey !== null &&
    bytesEqual(Uint8Array.from(userAccountKeypair.x25519Keypair.publicKey), onChainIdentity.tokenX25519PublicKey);

  if (!matchesTokenKey) {
    return { score: 0 };
  }

  if (
    !onChainIdentity.isUserCommitmentRegistered ||
    onChainIdentity.masterViewingKeyX25519PublicKey === null ||
    onChainIdentity.userCommitment === null
  ) {
    return { score: 1 };
  }

  const deriveMasterViewingKeyX25519 = getMasterViewingKeyX25519KeypairDeriver({ client: probeClient });
  const deriveMasterViewingKey = getMasterViewingKeyDeriver({ client: probeClient });
  const deriveMasterViewingKeyBlindingFactor = getMasterViewingKeyBlindingFactorDeriver({ client: probeClient });
  const derivePoseidonPrivateKey = getPoseidonPrivateKeyDeriver({ client: probeClient });
  const derivePoseidonBlindingFactor = getPoseidonBlindingFactorDeriver({ client: probeClient });
  const deriveUserCommitment = getUserCommitmentGeneratorFunction();

  const masterViewingKeyX25519 = await deriveMasterViewingKeyX25519();
  if (
    !bytesEqual(
      Uint8Array.from(masterViewingKeyX25519.x25519Keypair.publicKey),
      onChainIdentity.masterViewingKeyX25519PublicKey,
    )
  ) {
    return { score: 1 };
  }

  const localUserCommitment = await deriveUserCommitment(
    await deriveMasterViewingKey(),
    await deriveMasterViewingKeyBlindingFactor(),
    await derivePoseidonPrivateKey(),
    await derivePoseidonBlindingFactor(),
  );

  return {
    score: localUserCommitment === onChainIdentity.userCommitment ? 2 : 1,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function toMasterSeed(seed: Uint8Array): MasterSeed | null {
  if (seed.length !== EMPTY_MASTER_SEED.length) {
    return null;
  }
  return seed as unknown as MasterSeed;
}

function bytesToBigIntLe(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(bytes[index] ?? 0);
  }
  return result;
}

async function findEncryptedUserAccountPda(userAddress: string, programAddress: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programAddress as never,
    seeds: [ENCRYPTED_USER_ACCOUNT_SEED, getAddressEncoder().encode(userAddress as never)],
  });
  return pda;
}

async function createBackgroundUmbraWalletClientProxy(
  walletPublicKey: string,
  network: NetworkId,
): Promise<UmbraWalletClient> {
  return {
    registerConfidential: () =>
      invokeUmbraOperationInBackground<string[]>({
        walletPublicKey,
        network,
        operation: "registerConfidential",
      }),
    queryAccountState: (address) =>
      invokeUmbraOperationInBackground<UmbraRegistrationState>({
        walletPublicKey,
        network,
        operation: "queryAccountState",
        params: { address },
      }),
    queryBalances: (tokens = getUmbraTokens(network)) =>
      invokeUmbraOperationInBackground<UmbraTokenBalanceRecord[]>({
        walletPublicKey,
        network,
        operation: "queryBalances",
        params: { tokens },
      }),
    deposit: ({ destinationAddress, mint, amountAtomic }) =>
      invokeUmbraOperationInBackground<DepositResult>({
        walletPublicKey,
        network,
        operation: "deposit",
        params: {
          transfer: {
            destinationAddress,
            mint,
            amountAtomic: amountAtomic.toString(),
          },
        },
      }),
    withdraw: ({ destinationAddress, mint, amountAtomic }) =>
      invokeUmbraOperationInBackground<WithdrawResult>({
        walletPublicKey,
        network,
        operation: "withdraw",
        params: {
          transfer: {
            destinationAddress,
            mint,
            amountAtomic: amountAtomic.toString(),
          },
        },
      }),
    privateSendFromEncryptedBalance: ({ destinationAddress, mint, amountAtomic }) =>
      invokeUmbraOperationInBackground<CreateUtxoFromEncryptedBalanceResult>({
        walletPublicKey,
        network,
        operation: "privateSendFromEncryptedBalance",
        params: {
          privateTransfer: {
            destinationAddress,
            mint,
            amountAtomic: amountAtomic.toString(),
          },
        },
      }),
    privateSendFromPublicBalance: ({ destinationAddress, mint, amountAtomic }) =>
      invokeUmbraOperationInBackground<CreateUtxoFromPublicBalanceResult>({
        walletPublicKey,
        network,
        operation: "privateSendFromPublicBalance",
        params: {
          privateTransfer: {
            destinationAddress,
            mint,
            amountAtomic: amountAtomic.toString(),
          },
        },
      }),
    scanIncomingUtxos: (startIndex) =>
      invokeUmbraOperationInBackground<UmbraIncomingUtxos>({
        walletPublicKey,
        network,
        operation: "scanIncomingUtxos",
        params: startIndex === undefined ? undefined : { scanStartIndex: startIndex },
      }),
    claimIncomingToEncryptedBalance: (utxos) =>
      invokeUmbraOperationInBackground<ClaimUtxoIntoEncryptedBalanceResult>({
        walletPublicKey,
        network,
        operation: "claimIncomingToEncryptedBalance",
        params: {
          utxos: [...utxos],
        },
      }),
  };
}

function normalizeScannedUtxos(result: ScannedUtxoResult): UmbraIncomingUtxos {
  return {
    received: result.received ?? [],
    publicReceived: result.publicReceived ?? [],
    selfBurnable: result.selfBurnable ?? [],
    publicSelfBurnable: result.publicSelfBurnable ?? [],
    nextScanStartIndex:
      typeof result.nextScanStartIndex === "bigint"
        ? Number(result.nextScanStartIndex)
        : typeof result.nextScanStartIndex === "number"
          ? result.nextScanStartIndex
          : undefined,
  };
}

function normalizeClaimScanStartIndex(startIndex?: number): typeof CLAIM_SCAN_START {
  if (typeof startIndex !== "number" || !Number.isFinite(startIndex) || startIndex <= 0) {
    return CLAIM_SCAN_START;
  }

  return BigInt(Math.trunc(startIndex)) as never;
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
  const parsedBalance = BigInt(balanceAtomic);
  if (parsedBalance < 0n || parsedBalance > MAX_U64) {
    return {
      mint: token.mint,
      symbol: token.symbol,
      decimals: token.decimals,
      state: "error",
      error: "Umbra returned an invalid decrypted balance for this vault. The stored Umbra seed for this account is likely mismatched.",
      updatedAt: now,
    };
  }

  return {
    mint: token.mint,
    symbol: token.symbol,
    decimals: token.decimals,
    state: "shared",
    balanceAtomic,
    balanceUi: formatAtomicAmount(parsedBalance, token.decimals),
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
