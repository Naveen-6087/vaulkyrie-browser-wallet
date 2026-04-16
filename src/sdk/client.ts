import { Connection, PublicKey } from "@solana/web3.js";
import { VAULKYRIE_CORE_PROGRAM_ID, ACCOUNT_SIZE } from "./constants";
import {
  decodeVaultRegistry,
  decodePolicyReceiptState,
  decodeActionSessionState,
  decodeQuantumAuthority,
  decodeSpendOrchestration,
  decodeRecoveryState,
  decodeAuthorityProof,
} from "./accounts";
import type {
  VaultRegistryAccount,
  PolicyReceiptStateAccount,
  ActionSessionStateAccount,
  QuantumAuthorityAccount,
  SpendOrchestrationAccount,
  RecoveryStateAccount,
  AuthorityProofAccount,
} from "./types";
import {
  findVaultRegistryPda,
  findPolicyReceiptPda,
  findActionSessionPda,
  findQuantumAuthorityPda,
  findSpendOrchestrationPda,
} from "./pda";

/**
 * High-level Vaulkyrie client wrapping RPC calls and account decoding.
 */
export class VaulkyrieClient {
  readonly connection: Connection;
  readonly programId: PublicKey;

  constructor(
    connection: Connection,
    programId: PublicKey = VAULKYRIE_CORE_PROGRAM_ID
  ) {
    this.connection = connection;
    this.programId = programId;
  }

  private async fetchAccount(address: PublicKey): Promise<Uint8Array | null> {
    const info = await this.connection.getAccountInfo(address);
    if (!info || !info.data) return null;
    return new Uint8Array(info.data);
  }

  async getVaultRegistry(
    walletPubkey: PublicKey
  ): Promise<{ address: PublicKey; account: VaultRegistryAccount } | null> {
    const [pda] = findVaultRegistryPda(walletPubkey, this.programId);
    const data = await this.fetchAccount(pda);
    if (!data) return null;
    return { address: pda, account: decodeVaultRegistry(data) };
  }

  async getPolicyReceipt(
    vaultId: PublicKey,
    actionHash: Uint8Array
  ): Promise<{
    address: PublicKey;
    account: PolicyReceiptStateAccount;
  } | null> {
    const [pda] = findPolicyReceiptPda(vaultId, actionHash, this.programId);
    const data = await this.fetchAccount(pda);
    if (!data) return null;
    return { address: pda, account: decodePolicyReceiptState(data) };
  }

  async getActionSession(
    vaultId: PublicKey,
    actionHash: Uint8Array
  ): Promise<{
    address: PublicKey;
    account: ActionSessionStateAccount;
  } | null> {
    const [pda] = findActionSessionPda(vaultId, actionHash, this.programId);
    const data = await this.fetchAccount(pda);
    if (!data) return null;
    return { address: pda, account: decodeActionSessionState(data) };
  }

  async getQuantumAuthority(
    vaultId: PublicKey
  ): Promise<{
    address: PublicKey;
    account: QuantumAuthorityAccount;
  } | null> {
    const [pda] = findQuantumAuthorityPda(vaultId, this.programId);
    const data = await this.fetchAccount(pda);
    if (!data) return null;
    return { address: pda, account: decodeQuantumAuthority(data) };
  }

  async getSpendOrchestration(
    vaultId: PublicKey,
    actionHash: Uint8Array
  ): Promise<{
    address: PublicKey;
    account: SpendOrchestrationAccount;
  } | null> {
    const [pda] = findSpendOrchestrationPda(
      vaultId,
      actionHash,
      this.programId
    );
    const data = await this.fetchAccount(pda);
    if (!data) return null;
    return { address: pda, account: decodeSpendOrchestration(data) };
  }

  async getRecoveryState(
    address: PublicKey
  ): Promise<RecoveryStateAccount | null> {
    const data = await this.fetchAccount(address);
    if (!data) return null;
    return decodeRecoveryState(data);
  }

  async getAuthorityProof(
    address: PublicKey
  ): Promise<AuthorityProofAccount | null> {
    const data = await this.fetchAccount(address);
    if (!data) return null;
    return decodeAuthorityProof(data);
  }

  /** Check if a vault exists for a given wallet. */
  async vaultExists(walletPubkey: PublicKey): Promise<boolean> {
    const [pda] = findVaultRegistryPda(walletPubkey, this.programId);
    const info = await this.connection.getAccountInfo(pda);
    return info !== null && info.data.length >= ACCOUNT_SIZE.VaultRegistry;
  }
}
