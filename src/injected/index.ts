type ProviderEventName = "connect" | "disconnect" | "accountChanged";
type ProviderMethod =
  | "getState"
  | "connect"
  | "disconnect"
  | "getBalance"
  | "getTransactions"
  | "signTransaction";

interface ProviderState {
  connected: boolean;
  publicKey: string | null;
  network: string;
}

interface ProviderResponse<T = unknown> {
  id: string;
  result?: T;
  error?: string;
}

class InjectedPublicKey {
  private readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toBase58(): string {
    return this.value;
  }

  toString(): string {
    return this.value;
  }
}

class VaulkyrieProvider {
  readonly isVaulkyrie = true;
  isConnected = false;
  publicKey: InjectedPublicKey | null = null;
  network = "devnet";

  private readonly listeners = new Map<ProviderEventName, Set<(...args: unknown[]) => void>>();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();

  constructor() {
    window.addEventListener("message", this.handleWindowMessage);
    void this.hydrate();
  }

  on(event: ProviderEventName, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: ProviderEventName, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  async request<T = unknown>(args: { method: ProviderMethod; params?: Record<string, unknown> }): Promise<T> {
    return this.postRequest<T>(args.method, args.params);
  }

  async connect(): Promise<{ publicKey: InjectedPublicKey | null }> {
    const state = await this.postRequest<ProviderState>("connect");
    this.applyState(state);
    if (this.publicKey) {
      this.emit("connect", this.publicKey);
      this.emit("accountChanged", this.publicKey.toBase58());
    }
    return { publicKey: this.publicKey };
  }

  async disconnect(): Promise<void> {
    await this.postRequest("disconnect");
    this.applyState({
      connected: false,
      publicKey: null,
      network: this.network,
    });
    this.emit("disconnect");
    this.emit("accountChanged", null);
  }

  async signTransaction(): Promise<never> {
    throw new Error("Vaulkyrie extension transaction signing is not implemented yet.");
  }

  async signAllTransactions(): Promise<never> {
    throw new Error("Vaulkyrie extension transaction signing is not implemented yet.");
  }

  async signMessage(): Promise<never> {
    throw new Error("Vaulkyrie extension message signing is not implemented yet.");
  }

  private emit(event: ProviderEventName, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }

  private async hydrate(): Promise<void> {
    try {
      const state = await this.postRequest<ProviderState>("getState");
      this.applyState(state);
    } catch {
      // Ignore background unavailability during initial page load.
    }
  }

  private applyState(state: ProviderState): void {
    const previousPublicKey = this.publicKey?.toBase58() ?? null;

    this.isConnected = Boolean(state.connected && state.publicKey);
    this.publicKey = state.publicKey ? new InjectedPublicKey(state.publicKey) : null;
    this.network = state.network ?? this.network;

    const nextPublicKey = this.publicKey?.toBase58() ?? null;
    if (previousPublicKey !== null && previousPublicKey !== nextPublicKey) {
      this.emit("accountChanged", nextPublicKey);
    }
  }

  private async postRequest<T>(
    method: ProviderMethod,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = crypto.randomUUID();

    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    window.postMessage(
      {
        type: "VAULKYRIE_PROVIDER_REQUEST",
        id,
        method,
        params,
      },
      "*",
    );

    return response;
  }

  private readonly handleWindowMessage = (event: MessageEvent) => {
    if (event.source !== window || !event.data?.type) {
      return;
    }

    if (event.data.type === "VAULKYRIE_PROVIDER_RESPONSE") {
      const message = event.data as ProviderResponse;
      const pending = this.pending.get(message.id);
      if (!pending) return;

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (event.data.type === "VAULKYRIE_PROVIDER_EVENT" && event.data.event === "stateChanged") {
      this.applyState(event.data.state as ProviderState);
    }
  };
}

declare global {
  interface Window {
    vaulkyrie?: VaulkyrieProvider;
    solana?: VaulkyrieProvider;
  }
}

const provider = new VaulkyrieProvider();
window.vaulkyrie = provider;
if (!window.solana) {
  window.solana = provider;
}
window.dispatchEvent(new Event("vaulkyrie#initialized"));
