import { Connection, PublicKey } from "@solana/web3.js";
import {
  VAULKYRIE_POLICY_MXE_PROGRAM_ID,
  ACCOUNT_SIZE,
  SEED,
  PolicyEvaluationStatus,
} from "./constants";
import { decodePolicyConfig, decodePolicyEvaluation } from "./accounts";
import type { PolicyConfigAccount, PolicyEvaluationAccount } from "./types";

// ── PDA derivation ───────────────────────────────────────────────────

export function findPolicyConfigPda(
  authority: PublicKey,
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.PolicyConfig), authority.toBuffer()],
    programId
  );
}

export function findPolicyEvaluationPda(
  configPda: PublicKey,
  actionHash: Uint8Array,
  programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED.PolicyEvaluation),
      configPda.toBuffer(),
      Buffer.from(actionHash),
    ],
    programId
  );
}

// ── Client ───────────────────────────────────────────────────────────

/**
 * Read-only client for the Vaulkyrie Policy MXE program.
 *
 * Mirrors the pattern of `VaulkyrieClient` but targets the policy bridge
 * program. All RPC calls are read-only — instruction submission is handled
 * separately by the wallet signing flow.
 */
export class PolicyMxeClient {
  readonly connection: Connection;
  readonly programId: PublicKey;

  constructor(
    connection: Connection,
    programId: PublicKey = VAULKYRIE_POLICY_MXE_PROGRAM_ID
  ) {
    this.connection = connection;
    this.programId = programId;
  }

  private async fetchAccount(address: PublicKey): Promise<Uint8Array | null> {
    const info = await this.connection.getAccountInfo(address);
    if (!info || !info.data) return null;
    return new Uint8Array(info.data);
  }

  async getPolicyConfig(
    authority: PublicKey
  ): Promise<{ address: PublicKey; account: PolicyConfigAccount } | null> {
    const [pda] = findPolicyConfigPda(authority, this.programId);
    const data = await this.fetchAccount(pda);
    if (!data) return null;
    return { address: pda, account: decodePolicyConfig(data) };
  }

  async getPolicyEvaluation(
    configPda: PublicKey,
    actionHash: Uint8Array
  ): Promise<{ address: PublicKey; account: PolicyEvaluationAccount } | null> {
    const [pda] = findPolicyEvaluationPda(
      configPda,
      actionHash,
      this.programId
    );
    const data = await this.fetchAccount(pda);
    if (!data) return null;
    return { address: pda, account: decodePolicyEvaluation(data) };
  }

  /** Check if a policy config exists for a given authority. */
  async policyConfigExists(authority: PublicKey): Promise<boolean> {
    const [pda] = findPolicyConfigPda(authority, this.programId);
    const info = await this.connection.getAccountInfo(pda);
    return info !== null && info.data.length >= ACCOUNT_SIZE.PolicyConfigState;
  }

  /** Fetch all policy evaluations owned by this program (useful for dashboard). */
  async getAllEvaluations(): Promise<
    { address: PublicKey; account: PolicyEvaluationAccount }[]
  > {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: ACCOUNT_SIZE.PolicyEvaluationState },
      ],
    });

    return accounts
      .map(({ pubkey, account }) => {
        try {
          return {
            address: pubkey,
            account: decodePolicyEvaluation(new Uint8Array(account.data)),
          };
        } catch {
          return null;
        }
      })
      .filter(
        (x): x is { address: PublicKey; account: PolicyEvaluationAccount } =>
          x !== null
      );
  }

  /** Fetch evaluations for a specific vault. */
  async getEvaluationsForVault(
    vaultId: PublicKey
  ): Promise<{ address: PublicKey; account: PolicyEvaluationAccount }[]> {
    const all = await this.getAllEvaluations();
    const vaultBytes = vaultId.toBytes();
    return all.filter((e) => {
      const acctVault = e.account.vaultId;
      if (acctVault.length !== vaultBytes.length) return false;
      for (let i = 0; i < 32; i++) {
        if (acctVault[i] !== vaultBytes[i]) return false;
      }
      return true;
    });
  }

  /** Human-readable label for a policy evaluation status. */
  static statusLabel(status: PolicyEvaluationStatus): string {
    switch (status) {
      case PolicyEvaluationStatus.Pending:
        return "Pending";
      case PolicyEvaluationStatus.Finalized:
        return "Finalized";
      case PolicyEvaluationStatus.Aborted:
        return "Aborted";
      case PolicyEvaluationStatus.ComputationQueued:
        return "Computing";
      default:
        return "Unknown";
    }
  }
}
