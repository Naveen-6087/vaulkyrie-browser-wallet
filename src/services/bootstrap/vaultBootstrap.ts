import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { VaulkyrieClient } from "@/sdk/client";
import { PolicyMxeClient, findPolicyConfigPda } from "@/sdk/policyClient";
import {
  createInitAuthorityInstruction,
  createInitVaultInstruction,
} from "@/sdk/instructions";
import { createInitPolicyConfigInstruction } from "@/sdk/policyInstructions";
import {
  VAULKYRIE_CORE_PROGRAM_ID,
  VAULKYRIE_POLICY_MXE_PROGRAM_ID,
  ACCOUNT_SIZE,
} from "@/sdk/constants";
import { findQuantumAuthorityPda, findVaultRegistryPda } from "@/sdk/pda";
import {
  deserializeXmssTree,
  generateXmssTree,
  getInitialXmssAuthorityHash,
  serializeXmssTree,
} from "@/services/quantum/wots";
import {
  createWinterAuthoritySignerState,
  deserializeWinterAuthoritySignerState,
  serializeWinterAuthoritySignerState,
} from "@/services/quantum/winterAuthority";

export interface PreparedVaultBootstrap {
  transaction: Transaction | null;
  actions: string[];
  generatedXmssTree: string | null;
  generatedWinterAuthorityState: string | null;
  requiredFundingLamports: number;
}

const BOOTSTRAP_FEE_BUFFER_LAMPORTS = 100_000;
const STALE_CORE_BOOTSTRAP_ERROR =
  "The devnet Vaulkyrie core program is stale and cannot create bootstrap PDAs yet. " +
  "Redeploy vaulkyrie-core from the mpcwallet repo at commit 1c47a9a or newer, then retry on-chain bootstrap.";

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
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

function isInstructionError(err: unknown, name: string): boolean {
  if (
    err &&
    typeof err === "object" &&
    "InstructionError" in err &&
    Array.isArray((err as { InstructionError?: unknown }).InstructionError)
  ) {
    const [, code] = (err as { InstructionError: unknown[] }).InstructionError;
    return code === name;
  }

  return false;
}

function formatSimulationFailure(err: unknown, logs: string[] | null): string {
  const logText = logs?.length ? ` Logs: ${logs.join(" | ")}` : "";
  return `Bootstrap simulation failed: ${JSON.stringify(err)}.${logText}`;
}

/**
 * Simulate without signature verification before asking devices to run FROST.
 * This catches stale devnet deployments and account-layout mismatches before
 * users spend time producing a threshold signature for a transaction that the
 * program will immediately reject.
 */
export async function assertVaultBootstrapSimulation(
  connection: Connection,
  transaction: Transaction,
): Promise<void> {
  if (!transaction.feePayer || !transaction.recentBlockhash) {
    throw new Error("Bootstrap transaction is missing a fee payer or recent blockhash.");
  }

  const message = new TransactionMessage({
    payerKey: transaction.feePayer,
    recentBlockhash: transaction.recentBlockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();
  const simulatedTransaction = new VersionedTransaction(message);
  const result = await connection.simulateTransaction(simulatedTransaction, {
    commitment: "confirmed",
    sigVerify: false,
  });

  if (!result.value.err) {
    return;
  }

  const logs = result.value.logs ?? null;
  const invokesCore = logs?.some((line) =>
    line.includes(`Program ${VAULKYRIE_CORE_PROGRAM_ID.toBase58()} invoke`)
  );
  const invokesSystem = logs?.some((line) =>
    line.includes(`Program ${SystemProgram.programId.toBase58()} invoke`)
  );

  if (invokesCore && !invokesSystem && isInstructionError(result.value.err, "IncorrectProgramId")) {
    throw new Error(STALE_CORE_BOOTSTRAP_ERROR);
  }

  throw new Error(formatSimulationFailure(result.value.err, logs));
}

export async function prepareVaultBootstrapTransaction(params: {
  connection: Connection;
  walletPubkey: PublicKey;
  existingXmssTree: string | null;
  existingWinterAuthorityState?: string | null;
  defaultPolicyVersion?: bigint;
}): Promise<PreparedVaultBootstrap> {
  const {
    connection,
    walletPubkey,
    existingXmssTree,
    existingWinterAuthorityState = null,
    defaultPolicyVersion = 1n,
  } = params;

  const coreClient = new VaulkyrieClient(connection);
  const policyClient = new PolicyMxeClient(connection);

  const existingVault = await coreClient.getVaultRegistry(walletPubkey);
  const [vaultRegistryPda, vaultBump] = findVaultRegistryPda(walletPubkey);
  const existingAuthority = existingVault
    ? await coreClient.getQuantumAuthority(vaultRegistryPda)
    : null;
  const existingPolicyConfig = await policyClient.getPolicyConfig(walletPubkey);
  const [policyConfigPda, policyConfigBump] = findPolicyConfigPda(walletPubkey);

  let authorityHash = existingVault?.account.currentAuthorityHash ?? null;
  let authorityRoot = existingAuthority?.account.currentAuthorityRoot ?? null;
  let generatedXmssTree: string | null = null;
  let generatedWinterAuthorityState: string | null = null;

  if (!existingVault || !existingAuthority) {
    let winterAuthorityState = existingWinterAuthorityState
      ? await (async () => {
          try {
            return await deserializeWinterAuthoritySignerState(existingWinterAuthorityState);
          } catch {
            return null;
          }
        })()
      : null;

    if (!winterAuthorityState && !existingVault) {
      winterAuthorityState = await createWinterAuthoritySignerState();
      generatedWinterAuthorityState = serializeWinterAuthoritySignerState(winterAuthorityState);
    }

    if (winterAuthorityState) {
      const initialAuthorityRoot = winterAuthorityState.current.root;
      if (
        existingVault &&
        !equalBytes(existingVault.account.currentAuthorityHash, initialAuthorityRoot)
      ) {
        throw new Error(
          "The stored Winter authority state does not match this vault's on-chain authority root.",
        );
      }

      authorityHash = authorityHash ?? initialAuthorityRoot;
      authorityRoot = authorityRoot ?? initialAuthorityRoot;
    }

    let xmssTree = !authorityRoot && existingXmssTree
      ? (() => {
          try {
            return deserializeXmssTree(existingXmssTree);
          } catch {
            return null;
          }
        })()
      : null;

    if (!authorityRoot && !authorityHash && !xmssTree) {
      xmssTree = await generateXmssTree();
      generatedXmssTree = serializeXmssTree(xmssTree);
    }

    if (xmssTree) {
      const initialAuthorityHash = getInitialXmssAuthorityHash(xmssTree);
      if (
        existingVault &&
        !equalBytes(existingVault.account.currentAuthorityHash, initialAuthorityHash)
      ) {
        throw new Error(
          "The stored XMSS authority tree does not match this vault's on-chain authority hash.",
        );
      }

      authorityHash = authorityHash ?? initialAuthorityHash;
      authorityRoot = authorityRoot ?? new Uint8Array(xmssTree.root);
    }
  }

  const actions: string[] = [];
  const transaction = new Transaction();
  let requiredFundingLamports = 0;

  if (!existingVault) {
    requiredFundingLamports += await connection.getMinimumBalanceForRentExemption(
      ACCOUNT_SIZE.VaultRegistry,
    );
    if (!authorityHash) {
      throw new Error("Missing initial authority hash for vault bootstrap.");
    }

    transaction.add(createInitVaultInstruction(vaultRegistryPda, walletPubkey, {
      walletPubkey,
      authorityHash,
      policyVersion: defaultPolicyVersion,
      bump: vaultBump,
      policyMxeProgram: VAULKYRIE_POLICY_MXE_PROGRAM_ID,
    }));
    actions.push("vault registry");
  }

  if (!existingAuthority) {
    requiredFundingLamports += await connection.getMinimumBalanceForRentExemption(
      ACCOUNT_SIZE.QuantumAuthorityState,
    );
    if (!authorityHash || !authorityRoot) {
      throw new Error("Missing post-quantum authority material for bootstrap.");
    }

    const [authorityPda, authorityBump] = findQuantumAuthorityPda(vaultRegistryPda);
    transaction.add(createInitAuthorityInstruction(authorityPda, vaultRegistryPda, walletPubkey, {
      currentAuthorityHash: authorityHash,
      currentAuthorityRoot: authorityRoot,
      bump: authorityBump,
    }));
    actions.push("quantum authority");
  }

  if (!existingPolicyConfig) {
    requiredFundingLamports += await connection.getMinimumBalanceForRentExemption(
      ACCOUNT_SIZE.PolicyConfigState,
    );
    const policyVersion = existingVault?.account.policyVersion ?? defaultPolicyVersion;
    transaction.add(createInitPolicyConfigInstruction(policyConfigPda, walletPubkey, {
      coreProgram: VAULKYRIE_CORE_PROGRAM_ID.toBytes(),
      arciumProgram: VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBytes(),
      mxeAccount: VAULKYRIE_POLICY_MXE_PROGRAM_ID.toBytes(),
      policyVersion,
      bump: policyConfigBump,
    }));
    actions.push("policy config");
  }

  if (transaction.instructions.length === 0) {
    return {
      transaction: null,
      actions,
      generatedXmssTree,
      generatedWinterAuthorityState,
      requiredFundingLamports: 0,
    };
  }

  requiredFundingLamports += BOOTSTRAP_FEE_BUFFER_LAMPORTS;

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = walletPubkey;

  return {
    transaction,
    actions,
    generatedXmssTree,
    generatedWinterAuthorityState,
    requiredFundingLamports,
  };
}
