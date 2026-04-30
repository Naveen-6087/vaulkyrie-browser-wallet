import { requestCosignerSignature } from "@/services/cosigner/cosignerClient";
import {
  createRelay,
  generateSessionCode,
  probeRelayAvailability,
  resolveRelayUrl,
  type RelayAdapter,
} from "@/services/relay/relayAdapter";
import { useWalletStore } from "@/store/walletStore";
import type { SignRequestPayload } from "@/services/relay/channelRelay";
import { SigningOrchestrator } from "./signingOrchestrator";
import { bytesToHex, hexToBytes, signLocal } from "./frostService";
import { loadDkgResult } from "./signTransaction";

export async function signThresholdMessageWithCosigner(
  walletPublicKey: string,
  messageBytes: Uint8Array,
  onProgress?: (message: string) => void,
): Promise<Uint8Array> {
  const dkg = loadDkgResult(walletPublicKey);
  const availableKeyIds = Object.keys(dkg.keyPackages).map(Number).sort((left, right) => left - right);

  if (availableKeyIds.length >= dkg.threshold) {
    const signerIds = availableKeyIds.slice(0, dkg.threshold);
    const result = await signLocal(messageBytes, dkg.keyPackages, dkg.publicKeyPackage, signerIds);
    if (!result.verified) {
      throw new Error("FROST signature verification failed");
    }
    return hexToBytes(result.signatureHex);
  }

  const cosigner = dkg.cosigner;
  if (!cosigner?.enabled) {
    throw new Error(
      `This device only has ${availableKeyIds.length} of ${dkg.threshold} required key packages. ` +
        "Use a multi-device signing ceremony or a vault with an enabled server cosigner.",
    );
  }

  const participantId = dkg.participantId ?? availableKeyIds[0];
  if (!participantId) {
    throw new Error("No local participant key package found for cosigner-assisted signing.");
  }

  const keyPackageJson = dkg.keyPackages[participantId];
  if (!keyPackageJson) {
    throw new Error(`No key package found for participant ${participantId}.`);
  }

  const signerIds = [...new Set([participantId, cosigner.participantId])].sort((left, right) => left - right);
  if (signerIds.length < dkg.threshold) {
    throw new Error(
      `This vault needs ${dkg.threshold} signers, but the local device plus server cosigner provide ${signerIds.length}.`,
    );
  }

  const relayUrl = resolveRelayUrl(cosigner.relayUrl || useWalletStore.getState().relayUrl);
  const relayAvailable = await probeRelayAvailability(relayUrl);
  if (!relayAvailable) {
    throw new Error("Cross-device relay is unavailable right now. Start the relay server or check Settings > Cross-device Relay.");
  }

  return runCosignerSigningSession({
    walletPublicKey,
    messageBytes,
    participantId,
    signerIds: signerIds.slice(0, dkg.threshold),
    keyPackageJson,
    publicKeyPackageJson: dkg.publicKeyPackage,
    relayUrl,
    onProgress,
  });
}

async function runCosignerSigningSession({
  walletPublicKey,
  messageBytes,
  participantId,
  signerIds,
  keyPackageJson,
  publicKeyPackageJson,
  relayUrl,
  onProgress,
}: {
  walletPublicKey: string;
  messageBytes: Uint8Array;
  participantId: number;
  signerIds: number[];
  keyPackageJson: string;
  publicKeyPackageJson: string;
  relayUrl: string;
  onProgress?: (message: string) => void;
}): Promise<Uint8Array> {
  const { network, activeAccount, getDkgResult } = useWalletStore.getState();
  const cosigner = getDkgResult(walletPublicKey)?.cosigner ?? null;
  const requestedSessionCode = generateSessionCode();

  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    let signingStarted = false;
    let orchestrator: SigningOrchestrator | null = null;
    let relay: RelayAdapter | null = null;
    let timeout: number | null = null;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
      relay?.disconnect();
      callback();
    };

    const startSigningIfReady = () => {
      if (!relay || signingStarted) return;
      const connectedSignerIds = [
        participantId,
        ...relay
        .getParticipants()
        .map((candidate) => candidate.participantId),
      ].filter((candidate, index, values) => candidate > 0 && values.indexOf(candidate) === index);

      if (!signerIds.every((signerId) => connectedSignerIds.includes(signerId))) {
        onProgress?.(`Waiting for cosigner (${Math.min(connectedSignerIds.length, signerIds.length)}/${signerIds.length})...`);
        return;
      }

      signingStarted = true;
      onProgress?.("Cosigner connected. Signing Umbra operation...");

      const request: SignRequestPayload = {
        requestId: crypto.randomUUID(),
        message: Array.from(messageBytes),
        signerIds,
        amount: 0,
        token: "UMBRA",
        recipient: walletPublicKey,
        initiator: activeAccount?.name ?? "Vaulkyrie",
        network,
        createdAt: Date.now(),
        summary: "Authorize Umbra privacy operation",
        requiredSignerCount: signerIds.length,
      };
      relay.broadcastSignRequest(request);

      orchestrator = new SigningOrchestrator({
        relay,
        participantId,
        keyPackageJson,
        publicKeyPackageJson,
        message: messageBytes,
        signerIds,
        onProgress: (progress) => onProgress?.(progress.message),
      });

      void orchestrator.run()
        .then((result) => {
          if (!result.verified) {
            throw new Error("FROST signature verification failed");
          }
          relay?.broadcastSignComplete(result.signatureHex, result.verified);
          settle(() => resolve(hexToBytes(result.signatureHex)));
        })
        .catch((error) => settle(() => reject(error)));
    };

    relay = createRelay({
      mode: "remote",
      participantId,
      isCoordinator: true,
      deviceName: `Signer ${participantId}`,
      relayUrl,
      sessionId: requestedSessionCode,
      events: {
        onParticipantJoined: startSigningIfReady,
        onParticipantLeft: () => onProgress?.("Cosigner disconnected."),
        onSignRequest: () => {},
        onSignRound1: (fromId, commitments) => orchestrator?.handleSignRound1(fromId, commitments),
        onSignRound2: (fromId, share) => orchestrator?.handleSignRound2(fromId, share),
        onError: (_fromId, error) => settle(() => reject(new Error(`Signing relay error: ${error}`))),
        onDkgRound1: () => {},
        onDkgRound2: () => {},
        onDkgRound3Done: () => {},
        onStartDkg: () => {},
        onSignComplete: () => {},
      },
      onConnectionStateChange: (state) => {
        if (state === "connected") {
          onProgress?.("Connected to relay. Creating cosigner signing session...");
          relay?.createSession(signerIds.length, signerIds.length, requestedSessionCode);
        } else if (state === "failed") {
          settle(() => reject(new Error("Relay connection failed.")));
        }
      },
      onSessionCreated: (session) => {
        onProgress?.("Requesting server cosigner...");
        void requestCosignerSignature({ cosigner, relayUrl, session })
          .then((accepted) => {
            if (!accepted) {
              throw new Error("Server cosigner declined the signing request.");
            }
            onProgress?.("Server cosigner is joining...");
          })
          .catch((error) => settle(() => reject(error)));
      },
    });

    timeout = window.setTimeout(() => {
      settle(() => reject(new Error("Cosigner signing timed out after 2 minutes.")));
    }, 120_000);

    onProgress?.(`Preparing cosigner signing session ${bytesToHex(messageBytes).slice(0, 8)}...`);
    relay.connect();
  });
}
