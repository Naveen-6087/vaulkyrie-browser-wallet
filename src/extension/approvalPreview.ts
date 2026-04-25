import { Buffer } from "buffer";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type MessageCompiledInstruction,
} from "@solana/web3.js";
import type {
  ExtensionApprovalDetails,
  ExtensionApprovalDetailField,
} from "@/extension/approvalStorage";
import type {
  SignMessageParams,
  SignTransactionParams,
} from "@/extension/messages";
import type { TransactionAnalysis } from "@/services/transactionAnalysis";

function pushField(
  fields: ExtensionApprovalDetailField[],
  label: string,
  value: string | null | undefined,
  options?: Pick<ExtensionApprovalDetailField, "monospace" | "tone">,
) {
  if (!value) return;
  fields.push({
    label,
    value,
    monospace: options?.monospace,
    tone: options?.tone,
  });
}

function shortenBase58(value: string, visible: number = 6): string {
  if (value.length <= visible * 2) return value;
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

function utf8Preview(bytes: Uint8Array): string | null {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\s+/g, " ").trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function describePrograms(programs: string[]): string {
  if (programs.length === 0) {
    return "Unknown";
  }

  const preview = programs.slice(0, 3).map((program) => shortenBase58(program));
  return programs.length > 3 ? `${preview.join(", ")} +${programs.length - 3} more` : preview.join(", ");
}

function detailPackage(summary: string, details: ExtensionApprovalDetails): {
  summary: string;
  details: ExtensionApprovalDetails;
} {
  return { summary, details };
}

function feeLabel(lamports: number | null): string | null {
  if (lamports === null) return null;
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}

function appendAnalysisDetails(
  fields: ExtensionApprovalDetailField[],
  warnings: string[],
  analysis?: TransactionAnalysis,
) {
  if (!analysis) return;

  pushField(fields, "Estimated fee", feeLabel(analysis.estimatedFeeLamports), {
    monospace: true,
  });
  pushField(fields, "Writable accounts", `${analysis.writableAccountCount}`, {
    monospace: true,
  });
  pushField(fields, "Compute units", analysis.computeUnitsConsumed?.toLocaleString(), {
    monospace: true,
  });

  if (analysis.simulationError) {
    warnings.push(`Simulation warning: ${analysis.simulationError}`);
  }
}

export function buildMessageApprovalPreview(params: SignMessageParams): {
  summary: string;
  details: ExtensionApprovalDetails;
} {
  const bytes = Buffer.from(params.message, "base64");
  const preview = utf8Preview(bytes);
  const fields: ExtensionApprovalDetailField[] = [];
  const warnings: string[] = [];

  pushField(fields, "Bytes", `${bytes.length}`, { monospace: true });
  pushField(fields, "Encoding", preview ? "UTF-8 text" : "Binary data");
  pushField(
    fields,
    "Preview",
    preview ? `"${preview.slice(0, 160)}${preview.length > 160 ? "..." : ""}"` : Buffer.from(bytes).toString("hex").slice(0, 96),
    { monospace: !preview },
  );

  if (!preview) {
    warnings.push("This message is not valid UTF-8 text. Review the raw bytes carefully before approving.");
  }

  return detailPackage(
    preview
      ? `This site wants a ${bytes.length}-byte message signed by your vault.`
      : `This site wants a ${bytes.length}-byte binary payload signed by your vault.`,
    {
      title: "Message review",
      fields,
      warnings,
    },
  );
}

function legacyTransactionDetails(
  transaction: Transaction,
  walletPublicKey: string,
  analysis?: TransactionAnalysis,
): {
  fields: ExtensionApprovalDetailField[];
  warnings: string[];
  instructionCount: number;
  walletSignerRequired: boolean;
} {
  const fields: ExtensionApprovalDetailField[] = [];
  const warnings: string[] = [];
  const requiredSigners = transaction.signatures.map((signature) => signature.publicKey.toBase58());
  const walletSignerRequired = requiredSigners.includes(walletPublicKey);
  const feePayer = transaction.feePayer?.toBase58() ?? requiredSigners[0] ?? null;
  const programs = [...new Set(transaction.instructions.map((instruction) => instruction.programId.toBase58()))];

  pushField(fields, "Format", "Legacy");
  pushField(fields, "Fee payer", feePayer, { monospace: true });
  pushField(fields, "Vault signer", walletSignerRequired ? "Required signer" : "Not requested", {
    tone: walletSignerRequired ? "default" : "warning",
  });
  pushField(fields, "Instructions", `${transaction.instructions.length}`, { monospace: true });
  pushField(fields, "Required signers", `${requiredSigners.length}`, { monospace: true });
  pushField(fields, "Programs", describePrograms(programs), { monospace: true });
  pushField(fields, "Recent blockhash", transaction.recentBlockhash ?? null, { monospace: true });
  pushField(fields, "Message bytes", `${transaction.serializeMessage().length}`, { monospace: true });
  appendAnalysisDetails(fields, warnings, analysis);

  if (!walletSignerRequired) {
    warnings.push("The active vault is not listed as a required signer on this transaction.");
  }
  if (feePayer && feePayer !== walletPublicKey) {
    warnings.push("The fee payer is different from the active vault.");
  }
  if (requiredSigners.length > 1) {
    warnings.push("This transaction expects additional signers besides the active vault.");
  }
  if (transaction.instructions.length === 0) {
    warnings.push("This transaction has no instructions.");
  }

  return {
    fields,
    warnings,
    instructionCount: transaction.instructions.length,
    walletSignerRequired,
  };
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

function versionedTransactionDetails(
  transaction: VersionedTransaction,
  walletPublicKey: string,
  analysis?: TransactionAnalysis,
): {
  fields: ExtensionApprovalDetailField[];
  warnings: string[];
  instructionCount: number;
  walletSignerRequired: boolean;
} {
  const fields: ExtensionApprovalDetailField[] = [];
  const warnings: string[] = [];
  const staticKeys = transaction.message.staticAccountKeys;
  const requiredSigners = staticKeys
    .slice(0, transaction.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
  const walletSignerRequired = requiredSigners.includes(walletPublicKey);
  const feePayer = staticKeys[0]?.toBase58() ?? null;
  const programs = versionedProgramIds(staticKeys, transaction.message.compiledInstructions);

  pushField(fields, "Format", "Versioned");
  pushField(fields, "Fee payer", feePayer, { monospace: true });
  pushField(fields, "Vault signer", walletSignerRequired ? "Required signer" : "Not requested", {
    tone: walletSignerRequired ? "default" : "warning",
  });
  pushField(fields, "Instructions", `${transaction.message.compiledInstructions.length}`, { monospace: true });
  pushField(fields, "Required signers", `${requiredSigners.length}`, { monospace: true });
  pushField(fields, "Programs", describePrograms(programs), { monospace: true });
  pushField(fields, "Recent blockhash", transaction.message.recentBlockhash, { monospace: true });
  pushField(fields, "Message bytes", `${transaction.message.serialize().length}`, { monospace: true });
  appendAnalysisDetails(fields, warnings, analysis);

  if (!walletSignerRequired) {
    warnings.push("The active vault is not listed as a required signer on this versioned transaction.");
  }
  if (feePayer && feePayer !== walletPublicKey) {
    warnings.push("The fee payer is different from the active vault.");
  }
  if (requiredSigners.length > 1) {
    warnings.push("This transaction expects additional signers besides the active vault.");
  }
  if (transaction.message.compiledInstructions.length === 0) {
    warnings.push("This transaction has no instructions.");
  }
  if (transaction.message.addressTableLookups.length > 0) {
    warnings.push("This transaction uses address lookup tables. Review the requesting site carefully.");
  }

  return {
    fields,
    warnings,
    instructionCount: transaction.message.compiledInstructions.length,
    walletSignerRequired,
  };
}

export function buildTransactionApprovalPreview(
  params: SignTransactionParams,
  walletPublicKey: string,
  analysis?: TransactionAnalysis,
): {
  summary: string;
  details: ExtensionApprovalDetails;
  walletSignerRequired: boolean;
} {
  const rawBytes = Buffer.from(params.serializedTransaction, "base64");

  if (params.kind === "versioned") {
    const transaction = VersionedTransaction.deserialize(rawBytes);
    const { fields, warnings, instructionCount, walletSignerRequired } = versionedTransactionDetails(
      transaction,
      walletPublicKey,
      analysis,
    );
    return {
      summary: `This site wants a versioned transaction signed by your vault (${instructionCount} instruction${instructionCount === 1 ? "" : "s"}).`,
      details: { title: "Transaction review", fields, warnings },
      walletSignerRequired,
    };
  }

  const transaction = Transaction.from(rawBytes);
  const { fields, warnings, instructionCount, walletSignerRequired } = legacyTransactionDetails(
    transaction,
    walletPublicKey,
    analysis,
  );
  return {
    summary: `This site wants a legacy transaction signed by your vault (${instructionCount} instruction${instructionCount === 1 ? "" : "s"}).`,
    details: { title: "Transaction review", fields, warnings },
    walletSignerRequired,
  };
}
