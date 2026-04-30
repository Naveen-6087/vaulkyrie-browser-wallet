function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function findStringField(value: unknown, field: string): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const current = record[field];
  if (typeof current === "string" && current.trim()) {
    return current.trim();
  }

  return findStringField(record.context, field) ?? findStringField(record.cause, field);
}

function findStringArrayField(value: unknown, field: string): string[] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const current = record[field];
  if (Array.isArray(current) && current.every((entry) => typeof entry === "string")) {
    return current as string[];
  }

  return findStringArrayField(record.context, field) ?? findStringArrayField(record.cause, field);
}

function summarizeSimulationLogs(logs: string[]): string | undefined {
  const cleaned = logs
    .map((line) => line.replace(/^Program log:\s*/i, "").trim())
    .filter(Boolean);

  if (cleaned.length === 0) {
    return undefined;
  }

  return (
    cleaned.find((line) => /error|failed|insufficient|mismatch|invalid|not found|custom program error/i.test(line))
    ?? cleaned.at(-1)
  );
}

export function formatUmbraErrorMessage(error: unknown): string {
  const baseMessage = error instanceof Error ? error.message : String(error ?? "Umbra operation failed.");
  const stage = findStringField(error, "stage");
  const signature = findStringField(error, "signature");
  const failureReason = findStringField(error, "failureReason");
  const simulationLog = summarizeSimulationLogs(findStringArrayField(error, "simulationLogs") ?? []);

  const parts = [baseMessage.trim()];

  if (stage && !parts[0].toLowerCase().includes(`stage: ${stage}`)) {
    parts.push(`Stage: ${stage}.`);
  }

  if (failureReason && !parts.some((part) => part.includes(failureReason))) {
    parts.push(failureReason);
  }

  if (simulationLog && !parts.some((part) => part.includes(simulationLog))) {
    parts.push(`Simulation log: ${simulationLog}`);
  }

  if (signature && !parts.some((part) => part.includes(signature))) {
    parts.push(`Signature: ${signature}`);
  }

  return parts.join(" ").trim();
}
