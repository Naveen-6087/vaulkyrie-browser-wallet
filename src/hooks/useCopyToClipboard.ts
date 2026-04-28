import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/lib/utils";

interface UseCopyToClipboardOptions {
  resetAfterMs?: number;
}

export function useCopyToClipboard(options: UseCopyToClipboardOptions = {}) {
  const { resetAfterMs = 1800 } = options;
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const clearFeedback = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => () => clearFeedback(), [clearFeedback]);

  const copy = useCallback(
    async (value: string, key: string = "default") => {
      clearFeedback();

      try {
        await copyToClipboard(value);
        setCopiedKey(key);
        setCopyError(null);
        timeoutRef.current = window.setTimeout(() => {
          setCopiedKey(null);
        }, resetAfterMs);
      } catch (error) {
        setCopiedKey(null);
        setCopyError(error instanceof Error ? error.message : "Copy failed.");
        timeoutRef.current = window.setTimeout(() => {
          setCopyError(null);
        }, resetAfterMs);
      }
    },
    [clearFeedback, resetAfterMs],
  );

  return {
    copiedKey,
    copyError,
    copy,
    isCopied: (key: string = "default") => copiedKey === key,
  };
}
