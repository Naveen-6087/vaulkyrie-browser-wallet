import { Buffer } from "buffer";
import { encryptString } from "@/lib/crypto";
import type { PrivacyVaultEncryptedKeyRecord } from "@/store/walletStore";

export async function createEncryptedPrivacyVaultKeyRecord(
  secretKey: Uint8Array,
  password: string,
): Promise<PrivacyVaultEncryptedKeyRecord> {
  const payload = await encryptString(Buffer.from(secretKey).toString("base64"), password);
  return {
    kind: "privacy-vault-key",
    version: 1,
    ...payload,
  };
}
