import { Connection, PublicKey, Transaction } from "@solana/web3.js";
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
} from "@/sdk/constants";
import { findQuantumAuthorityPda, findVaultRegistryPda } from "@/sdk/pda";
import {
  deserializeXmssTree,
  generateXmssTree,
  getInitialXmssAuthorityHash,
  serializeXmssTree,
} from "@/services/quantum/wots";

export interface PreparedVaultBootstrap {
  transaction: Transaction | null;
  actions: string[];
  generatedXmssTree: string | null;
}

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

export async function prepareVaultBootstrapTransaction(params: {
  connection: Connection;
  walletPubkey: PublicKey;
  existingXmssTree: string | null;
  defaultPolicyVersion?: bigint;
}): Promise<PreparedVaultBootstrap> {
  const {
    connection,
    walletPubkey,
    existingXmssTree,
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

  if (!existingVault || !existingAuthority) {
    let xmssTree = existingXmssTree
      ? (() => {
          try {
            return deserializeXmssTree(existingXmssTree);
          } catch {
            return null;
          }
        })()
      : null;

    if (!xmssTree) {
      xmssTree = await generateXmssTree();
      generatedXmssTree = serializeXmssTree(xmssTree);
    }

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

  const actions: string[] = [];
  const transaction = new Transaction();

  if (!existingVault) {
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
    if (!authorityHash || !authorityRoot) {
      throw new Error("Missing XMSS authority material for bootstrap.");
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
    return { transaction: null, actions, generatedXmssTree };
  }

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = walletPubkey;

  return { transaction, actions, generatedXmssTree };
}
