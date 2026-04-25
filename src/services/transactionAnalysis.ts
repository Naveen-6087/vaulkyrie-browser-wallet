import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type MessageCompiledInstruction,
} from "@solana/web3.js";
import type { NetworkId } from "@/lib/constants";
import type { SignTransactionParams } from "@/extension/messages";
import { withRpcFallback } from "@/services/solanaRpc";

export interface TransactionAnalysis {
  estimatedFeeLamports: number | null;
  computeUnitsConsumed: number | null;
  simulationError: string | null;
  instructionCount: number;
  requiredSignerCount: number;
  writableAccountCount: number;
  feePayer: string | null;
  walletSignerRequired: boolean;
  hasAddressLookupTables: boolean;
  programIds: string[];
}

function uniqueProgramIds(programs: string[]): string[] {
  return [...new Set(programs)];
}

function versionedProgramIds(
  staticKeys: PublicKey[],
  instructions: readonly MessageCompiledInstruction[],
): string[] {
  const programs = new Set<string>();
  for (const instruction of instructions) {
    if (instruction.programIdIndex < staticKeys.length) {
      programs.add(staticKeys[instruction.programIdIndex].toBase58());
    }
  }
  return [...programs];
}

async function estimateLegacyFee(
  connection: Connection,
  transaction: Transaction,
): Promise<number | null> {
  try {
    const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
    return fee.value ?? null;
  } catch {
    return null;
  }
}

async function estimateVersionedFee(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<number | null> {
  try {
    const fee = await connection.getFeeForMessage(transaction.message, "confirmed");
    return fee.value ?? null;
  } catch {
    return null;
  }
}

async function simulateLegacyTransaction(
  connection: Connection,
  transaction: Transaction,
): Promise<{ computeUnitsConsumed: number | null; simulationError: string | null }> {
  try {
    const result = await connection.simulateTransaction(transaction);
    return {
      computeUnitsConsumed: result.value.unitsConsumed ?? null,
      simulationError: result.value.err ? JSON.stringify(result.value.err) : null,
    };
  } catch (error) {
    return {
      computeUnitsConsumed: null,
      simulationError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function simulateVersionedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<{ computeUnitsConsumed: number | null; simulationError: string | null }> {
  try {
    const result = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    return {
      computeUnitsConsumed: result.value.unitsConsumed ?? null,
      simulationError: result.value.err ? JSON.stringify(result.value.err) : null,
    };
  } catch (error) {
    return {
      computeUnitsConsumed: null,
      simulationError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function analyzeLegacyTransaction(
  connection: Connection,
  transaction: Transaction,
  walletPublicKey: string,
): Promise<TransactionAnalysis> {
  const message = transaction.compileMessage();
  const accountKeys = message.accountKeys;
  const requiredSignerKeys = accountKeys.slice(0, message.header.numRequiredSignatures);
  const writableAccountCount =
    message.header.numRequiredSignatures -
    message.header.numReadonlySignedAccounts +
    (accountKeys.length - message.header.numRequiredSignatures - message.header.numReadonlyUnsignedAccounts);
  const [estimatedFeeLamports, simulation] = await Promise.all([
    estimateLegacyFee(connection, transaction),
    simulateLegacyTransaction(connection, transaction),
  ]);

  return {
    estimatedFeeLamports,
    computeUnitsConsumed: simulation.computeUnitsConsumed,
    simulationError: simulation.simulationError,
    instructionCount: transaction.instructions.length,
    requiredSignerCount: requiredSignerKeys.length,
    writableAccountCount,
    feePayer: transaction.feePayer?.toBase58() ?? requiredSignerKeys[0]?.toBase58() ?? null,
    walletSignerRequired: requiredSignerKeys.some((key) => key.toBase58() === walletPublicKey),
    hasAddressLookupTables: false,
    programIds: uniqueProgramIds(transaction.instructions.map((instruction) => instruction.programId.toBase58())),
  };
}

export async function analyzeVersionedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  walletPublicKey: string,
): Promise<TransactionAnalysis> {
  const staticKeys = transaction.message.staticAccountKeys;
  const requiredSignerKeys = staticKeys.slice(0, transaction.message.header.numRequiredSignatures);
  const writableAccountCount =
    transaction.message.header.numRequiredSignatures -
    transaction.message.header.numReadonlySignedAccounts +
    (staticKeys.length -
      transaction.message.header.numRequiredSignatures -
      transaction.message.header.numReadonlyUnsignedAccounts);
  const [estimatedFeeLamports, simulation] = await Promise.all([
    estimateVersionedFee(connection, transaction),
    simulateVersionedTransaction(connection, transaction),
  ]);

  return {
    estimatedFeeLamports,
    computeUnitsConsumed: simulation.computeUnitsConsumed,
    simulationError: simulation.simulationError,
    instructionCount: transaction.message.compiledInstructions.length,
    requiredSignerCount: requiredSignerKeys.length,
    writableAccountCount,
    feePayer: staticKeys[0]?.toBase58() ?? null,
    walletSignerRequired: requiredSignerKeys.some((key) => key.toBase58() === walletPublicKey),
    hasAddressLookupTables: transaction.message.addressTableLookups.length > 0,
    programIds: versionedProgramIds(staticKeys, transaction.message.compiledInstructions),
  };
}

export async function analyzeSerializedTransaction(
  network: NetworkId,
  params: SignTransactionParams,
  walletPublicKey: string,
): Promise<TransactionAnalysis> {
  return withRpcFallback(network, async (connection) => {
    if (params.kind === "versioned") {
      const transaction = VersionedTransaction.deserialize(
        Buffer.from(params.serializedTransaction, "base64"),
      );
      return analyzeVersionedTransaction(connection, transaction, walletPublicKey);
    }

    const transaction = Transaction.from(Buffer.from(params.serializedTransaction, "base64"));
    return analyzeLegacyTransaction(connection, transaction, walletPublicKey);
  });
}
