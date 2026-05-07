# Vaulkyrie Pitch Pack

This file is grounded in **two codebases**:

- `vaulkyrie-browser-wallet` — the browser extension, relay-facing wallet UX, Umbra privacy flows, local key storage, quantum-vault UI, and threshold-signing orchestration.
- `C:\Users\hemav\OneDrive\Desktop\mpcwallet` — the protocol workspace with the FROST harness, shared protocol types, WOTS/XMSS/Winternitz logic, Solana settlement program, SDK, CLI, and architecture docs.

## What is implemented vs. what is still a claim

- **Clearly implemented in code today:** browser extension wallet UX, DKG ceremony UX, relay-based signing orchestration, optional cosigner hooks, Umbra privacy flows, local encrypted key storage, Winternitz/WOTS browser logic, FROST conformance harness, protocol encodings, Solana core program state machine, SDK, CLI, and devnet program IDs referenced in docs.
- **Documented but not fully evidenced in the checked-out source here:** the `vaulkyrie-policy-mxe` program source is referenced in `mpcwallet` docs and contributor instructions, but that program’s source is **not present** in the current workspace; treat those policy-plane claims as documented architecture/deployment status rather than source directly audited here.
- **Honest positioning:** Vaulkyrie is a strong **architecture + working wallet prototype + protocol foundation**. It should not be pitched as fully production-ready until end-to-end integration, audit, and mainnet hardening are complete.

---

## Pitch 1 — Deep technical version

### One-line thesis

**Vaulkyrie is a Solana wallet architecture that splits custody into four planes: threshold Ed25519 for spend, private policy evaluation for risk, post-quantum Winternitz authority for high-risk admin actions, and a minimal onchain coordination layer that keeps secrets offchain.**

### The technical story

Most wallets force one bad tradeoff: either you keep a single private key and gain speed but inherit a catastrophic single point of failure, or you move to heavyweight smart-account or treasury-style controls and lose the clean UX and compatibility of a normal wallet. Vaulkyrie takes a different path.

For **routine spending**, Vaulkyrie stays fully compatible with Solana’s native transaction model. The spend key is still an **Ed25519 key**, because Solana validators ultimately verify standard Ed25519 signatures over serialized message bytes. But Vaulkyrie does **not** reconstruct that key on any one device. Instead, devices run **dealerless FROST DKG** offchain, each device stores only its own share, and a coordinator collects signature shares and aggregates them into a single 64-byte Ed25519 signature that looks normal to Solana. In the protocol workspace, this is evidenced by `mpcwallet\crates\vaulkyrie-frost\src\lib.rs`, which runs `frost-ed25519` DKG part 1/2/3, commits nonces, produces signature shares, aggregates them, verifies them with the FROST verifying key, then re-verifies the same signature with `ed25519-dalek`, and includes a Solana legacy-message harness. In the browser wallet, the product side of that flow shows up in `src\components\ceremony\DKGCeremony.tsx`, `src\services\frost\*`, `src\services\relay\*`, `src\pages\QuantumVault.tsx`, and `src\App.tsx`.

That gives Vaulkyrie its **TSS layer**: a threshold signer that preserves normal Solana wallet semantics. The important architectural point is that the threshold system is **offchain by design**. The chain never sees device shares, DKG transcripts, or MPC internals. The chain just sees a valid Ed25519 signature and a small amount of coordination state. That is exactly the right design for Solana, because it preserves compatibility with the existing transaction system instead of trying to force a smart-account abstraction onto a chain that expects native signers.

Now add the second layer: **post-quantum authority**, but only where it actually makes sense.

Vaulkyrie does **not** try to use PQC for every daily spend. That would be a poor fit operationally and economically, and the codebase itself already makes that design choice explicit in `mpcwallet\README.md` and `mpcwallet\ARCHITECTURE.md`: routine spend stays Ed25519, while PQC protects **high-risk lifecycle actions** such as recovery, rekey, authority rotation, vault close, and policy changes. This is the right split because hash-based one-time systems are powerful but stateful. They are excellent for rare, high-consequence actions; they are not ideal for every coffee purchase.

The PQC/admin layer is built around **Winternitz hash-based signatures**:

- In the browser wallet, `src\services\quantum\wots.ts` implements a browser-side WOTS/WOTS+-style system with explicit constants, one-time-key semantics, mnemonic-backed derivation, Merkle-style public-key hashing, and support for a Solana-oriented Winternitz variant.
- In the protocol workspace, `mpcwallet\crates\vaulkyrie-protocol\src\lib.rs` defines the canonical WOTS constants, XMSS tree height, `WotsAuthProof`, `WotsSecretKey`, `WinterAuthorityAdvanceStatement`, `WinterAuthoritySignature`, and verification utilities such as digest verification and Merkle-root verification.
- In the core program, `mpcwallet\programs\vaulkyrie-core\src\instruction.rs` and `transition.rs` wire those proofs into actual authorization paths: rotate authority, init recovery, complete recovery, migrate authority, and advance a WinterWallet-style root-rolling authority.

The critical nuance here is that Vaulkyrie is using **Winternitz/WOTS/XMSS as a stateful, root-rolling admin plane**, not as a blanket replacement for the normal spend key. In practical terms, every high-risk admin action is bound to:

- an **action hash**
- the **current authority root/hash**
- the **next authority root/hash**
- a **sequence number**
- an **expiry slot**

That is a very strong design choice. It means a recovery or rekey is not just “signed”; it is **state-transition-bound**. The signature is only valid for the exact action, at the exact point in the authority chain, within the exact freshness window. `mpcwallet\programs\vaulkyrie-core\src\transition.rs` explicitly enforces replay protection, sequence monotonicity, leaf consumption, expiry windows, action binding, and Merkle-root matching. In other words: Vaulkyrie’s PQC layer is not decorative crypto. It is being used as a **state machine for irreversible admin control**.

The browser wallet extends that concept into a user-facing **Quantum Vault** flow. `src\pages\QuantumVault.tsx` and `src\background\quantumVaultSession.ts` show a wallet PDA model where the current Winternitz root authorizes state advancement and the next root is precommitted. `prepareQuantumVaultAdvanceInBackground()` loads the local key state, verifies the current root against onchain state, derives the next key, constructs the advance message, signs it with either the Solana Winternitz or legacy browser WOTS path, verifies the signature locally, and only then serializes it for the program instruction. That is a very credible root-rolling pattern for vault migration, close, or split semantics.

The third plane is **privacy**.

This is where Vaulkyrie is more interesting than a normal threshold wallet because it does not stop at “shared custody.” In the browser repo, Vaulkyrie has a real **Umbra Privacy Vault** integration, not just a slide claim:

- `src\services\umbra\umbraClient.ts` creates an Umbra wallet client on top of `@umbra-privacy/sdk`.
- It supports **confidential + anonymous registration**.
- It supports **public-to-encrypted deposits**.
- It supports **encrypted-to-public withdrawals**.
- It supports **private sends** from both public balance and encrypted balance into **receiver-claimable UTXOs**.
- It supports **incoming UTXO scanning** and **claiming** back into encrypted balance.
- It uses `@umbra-privacy\web-zk-prover` where needed.
- For Arcium-backed operations, it explicitly waits for computation finalization via the `ARCIUM_FINALIZATION` options passed to deposit, withdraw, and encrypted-balance private-send flows.

This matters because it means Vaulkyrie is not just “private” in the marketing sense. It is actually wiring a privacy system with:

- an encrypted-balance model
- anonymous registration state
- UTXO-style private transfer flows
- relayer/indexer requirements for claims
- deterministic or stored Umbra master-seed handling
- onchain identity checks using X25519 and user commitments

That last point is particularly strong. `src\services\umbra\umbraClient.ts` does more than call SDK helpers; it validates the local Umbra seed against the **onchain Umbra identity state** by checking X25519 public keys and the user commitment. That prevents a subtle but real failure mode where a user has the wrong local privacy seed and sees nonsense balance data. This is exactly the kind of implementation detail that signals engineering seriousness.

The fourth plane is **settlement and enforcement on Solana**.

In `mpcwallet`, the core onchain program is intentionally small and explicit. `mpcwallet\programs\vaulkyrie-core\src\state.rs`, `instruction.rs`, `transition.rs`, and `processor.rs` define fixed-size state, explicit byte-level instruction parsing, PDA derivation, error codes, recovery sessions, spend orchestration, PQC wallet state, and authority verification. The design goal is clear: the chain stores **coordination state**, **replay protection**, and **policy/authority bindings**, but not raw secrets and not heavy offchain cryptographic internals.

That separation is the real architectural advantage:

1. **Spend plane** — FROST threshold Ed25519 produces normal Solana signatures.
2. **Policy plane** — documented as an Arcium/Anchor bridge that decides thresholds or delays privately.
3. **Authority plane** — Winternitz/WOTS/XMSS protects high-risk admin transitions.
4. **Settlement plane** — the Solana program verifies state transitions and binds them to action/session hashes.

So the full argument is:

**Vaulkyrie is not “just multisig.”** It is a layered wallet system where:

- normal spend remains fast and chain-compatible,
- higher-risk actions demand stronger cryptographic ceremony,
- privacy lives in a separate but integrated user-facing vault,
- and the chain remains minimal, auditable, and replay-safe.

### Why FROST specifically matters

FROST is the right threshold choice here because Vaulkyrie needs **Ed25519 compatibility** rather than a generic MPC demo. In `mpcwallet\crates\vaulkyrie-frost\src\lib.rs`, the harness proves the exact thing a Solana wallet needs:

- dealerless DKG
- threshold signing
- deterministic public-key derivation
- share refresh
- retry logic
- verification by standard Ed25519 tooling
- compatibility with serialized Solana legacy message bytes

That is the key distinction between “interesting threshold research” and “wallet-ready threshold infrastructure.” Vaulkyrie is building the latter.

### Why Winternitz/XMSS matters here

Winternitz and XMSS give Vaulkyrie a **hash-based post-quantum control path** for the handful of actions that can permanently change custody. That means even if the future threat model changes, the most catastrophic account actions can already live behind a hash-based, one-time, replay-resistant authority layer. The codebase also makes the right engineering concession: XMSS scheduling stays largely offchain, while onchain logic enforces only the invariants it must actually understand.

### Why Umbra matters here

Umbra lets Vaulkyrie offer something most security-first wallets still do not: **usable privacy as part of the wallet suite**, not as a separate product. In Vaulkyrie, privacy is not just “hide my address”; it is:

- confidential account registration
- encrypted balances
- receiver-claimable private notes
- scan-and-claim inbox flows
- relayer/indexer-aware UX
- local master-seed handling with identity validation

That turns Vaulkyrie into a wallet stack that treats **custody, privacy, and future-proof admin control** as one problem rather than three disconnected features.

### Technical pitch close

**Vaulkyrie’s core innovation is architectural discipline.** It uses the right cryptography in the right place: FROST for normal spend, Umbra for privacy, Winternitz/XMSS for high-risk admin control, and a minimal Solana program for state coordination. That is how you build a wallet that is safer than a seed phrase, more private than a standard hot wallet, and more future-resilient than a pure Ed25519 stack without breaking Solana compatibility.

---

## Pitch 2 — Simple market / business version

### Simple headline

**Vaulkyrie is building the wallet people actually need next: not just a place to hold assets, but a full security stack for spending, privacy, recovery, and high-risk account control.**

### The simple story

Crypto users have learned the same lesson over and over: the weak point is not the blockchain, it is the wallet. If a single seed phrase or a single device controls everything, then one phishing attack, one malware infection, one SIM swap, one rogue employee, or one physical coercion event can wipe out the account.

The market has also changed. Wallets are no longer just passive storage. They are where people trade, bridge, swap, stake, receive payroll, use DeFi, and manage identities. That makes the wallet the **highest-value attack surface** in crypto.

The timing is real:

- **Chainalysis** reported that more than **$2.17B** had already been stolen from crypto services by mid-2025, already worse than all of 2024, with **personal wallet compromises representing 23.35%** of stolen-fund activity year-to-date and the **$1.5B Bybit hack** setting a new record.
- In its 2025 crime reporting, **Chainalysis** also estimated 2024 illicit crypto volume could ultimately exceed **$51B** as more illicit addresses are identified over time.
- On the demand side, **Phantom’s own Series C announcement** said it had reached **15M monthly active users, $20B annual swap volume, 850M onchain transactions, and $25B in self-custody assets**. That proves wallet behavior is becoming mainstream, high-frequency, and valuable enough to protect far better.

That is why Vaulkyrie matters.

Vaulkyrie is not trying to beat Phantom by being “Phantom, but purple.” It is trying to win a different category: **high-trust self-custody**.

### What users get

Vaulkyrie is really a **wallet suite**, not a single wallet mode.

1. **Threshold Vault**
   - Multi-device threshold signing instead of one exposed seed phrase.
   - Optional assisted vault flow with a cosigner model.
   - Cross-device ceremonies using QR/session-based orchestration.

2. **Privacy Vault**
   - Umbra-powered privacy account with encrypted balances.
   - Shield, unshield, private-send, scan inbox, and claim flows.
   - Good fit for users who do not want every balance and transfer to be trivial to trace.

3. **Quantum / Admin Vault**
   - Post-quantum Winternitz authority for the scariest actions: recovery, rekey, authority migration, lock, and close.
   - This is not just security theater; it is a separate control rail for high-consequence changes.

4. **Recovery + coordination layer**
   - Recovery sessions, orchestration tracking, policy-aware flows, and explicit lifecycle state rather than ad hoc wallet recovery.

### Why people need this

Because today’s wallet market still forces bad choices:

- **Single-key hot wallets** are fast but fragile.
- **Hardware wallets** are secure for cold storage but clumsy for collaborative, mobile, or high-frequency use.
- **Treasury multisigs** are strong for organizations but often too heavy for normal users and not designed like a first-class consumer wallet.
- **Privacy tools** usually live outside the main wallet, which means privacy is bolted on after the fact.

Vaulkyrie says: keep the wallet usable, but split the risk across different rails.

### Compare and contrast

| Wallet / category | Strengths | Weaknesses vs. Vaulkyrie | Vaulkyrie advantage |
| --- | --- | --- | --- |
| **Phantom / Backpack** | Best-in-class Solana UX, huge distribution, fast swaps, broad dApp support | Primarily optimized for convenience and daily retail flows; threshold custody and dedicated privacy/admin planes are not the core product | Vaulkyrie is built around **shared custody, recovery discipline, privacy, and admin hardening** |
| **Ledger / Trezor** | Excellent cold storage and key isolation | Not designed as a collaborative, policy-aware, cross-device wallet product | Vaulkyrie is better for **active self-custody**, shared control, and operational workflows |
| **Safe-style multisig** | Strong treasury controls and policy layers | Usually not native consumer Solana wallet UX; can feel operationally heavy | Vaulkyrie keeps **standard Solana signature compatibility** while adding threshold control offchain |
| **Pure privacy tools** | Better privacy than standard wallets | Usually separate from the main wallet experience | Vaulkyrie brings privacy into the wallet suite itself via Umbra |

The honest comparison is this:

- **Vaulkyrie is stronger than mainstream wallets on security architecture.**
- **Vaulkyrie is stronger than hardware-only setups on collaborative usability.**
- **Vaulkyrie is stronger than treasury-only tools on consumer-wallet ergonomics.**
- **Vaulkyrie is weaker today on distribution, battle testing, and brand trust** because it is earlier-stage.

### Why this can become a real business

The code already hints at multiple revenue paths:

1. **Premium assisted custody**
   - The browser wallet and relay server already contain optional **cosigner** flows.
   - That can become a subscription product for individuals, families, funds, and teams that want fast 2-of-2 or 2-of-3 assisted security.

2. **Relay / orchestration infrastructure**
   - Cross-device DKG and signing need reliable relay infrastructure.
   - That naturally supports managed relay plans, enterprise SLAs, or white-labeled orchestration.

3. **PQC onboarding sponsorship / premium security tiers**
   - The codebase already contains a **PQC sponsor** path.
   - That can become a paid premium tier, a partner-funded onboarding tool, or a high-value security bundle.

4. **Policy and governance products**
   - The architecture is already designed for private policy evaluation and action-based authorization.
   - That opens enterprise/team use cases: treasury policy, spend approval, recovery policy, VIP accounts, DAO operators, and family-office custody.

5. **White-label wallet stack**
   - Because there is a separate protocol workspace, SDK, CLI, and browser wallet, Vaulkyrie can evolve into infrastructure sold to other wallet operators, custodians, fintech apps, or institutions that want threshold + privacy + recovery without building it from scratch.

### The strongest market positioning

The cleanest way to position Vaulkyrie is:

**“The security-first Solana wallet suite for people who need more than a seed phrase.”**

Not “the next generic wallet.”

Not “just another extension.”

Instead:

- for power users who want self-custody without single-key fragility
- for teams and shared accounts that need threshold control
- for privacy-sensitive users who do not want every wallet action to be public by default
- for high-net-worth users and operators who care about recovery, policy, and future-proof admin control

### The simple close

Mainstream wallets proved there is huge demand. Security data proves the current model is still too fragile. Vaulkyrie sits exactly in that gap: **a wallet suite that combines threshold custody, privacy, recovery, and post-quantum admin control without abandoning the usability of a real Solana wallet.**

---

## Suggested talk tracks

### 30-second version

Vaulkyrie is a next-generation Solana wallet suite built for users who have outgrown the single-seed-phrase model. We combine threshold signing for everyday spend, Umbra-powered privacy for private balances and transfers, and a post-quantum Winternitz authority layer for recovery and high-risk admin actions. The result is a wallet that is harder to compromise, easier to share safely across devices, and better aligned with where self-custody is going.

### 90-second version

Most wallets optimize for convenience, but the last few years have shown that convenience alone is not enough. Wallet compromise is now a major attack vector, and users are storing, trading, and moving serious value through self-custody apps. Vaulkyrie solves that by splitting wallet security into layers. For normal spending, we use FROST threshold signing so no single device ever has the whole spend secret, but the final transaction still looks like a normal Solana signature. For privacy, we integrate Umbra directly into the wallet so users can register confidential accounts, shield funds, send private notes, and claim them back into encrypted balances. For the highest-risk account actions like recovery and rekey, we use a Winternitz-based post-quantum authority path with stateful root rotation. So instead of one key doing everything badly, Vaulkyrie gives each class of wallet action the right security model.

---

## Evidence map

### Browser wallet repo

- Manifest / extension identity: `manifest.config.ts`
- Main wallet routing and account modes: `src\App.tsx`
- Threshold ceremony UX: `src\components\ceremony\DKGCeremony.tsx`
- Quantum-vault UI and cross-device spend orchestration: `src\pages\QuantumVault.tsx`
- PQC signing/session logic: `src\background\quantumVaultSession.ts`
- Browser Winternitz/WOTS implementation: `src\services\quantum\wots.ts`
- Privacy vault key/session handling: `src\background\vaultSession.ts`
- Umbra client and privacy flows: `src\services\umbra\umbraClient.ts`
- Privacy UX: `src\components\wallet\PrivacyView.tsx`
- Wallet state and persisted records: `src\store\walletStore.ts`

### Protocol workspace

- Workspace overview and hard decisions: `C:\Users\hemav\OneDrive\Desktop\mpcwallet\README.md`
- System architecture: `C:\Users\hemav\OneDrive\Desktop\mpcwallet\ARCHITECTURE.md`
- Completed phases and test counts: `C:\Users\hemav\OneDrive\Desktop\mpcwallet\IMPLEMENTATION_STATUS.md`
- FROST harness: `C:\Users\hemav\OneDrive\Desktop\mpcwallet\crates\vaulkyrie-frost\src\lib.rs`
- Protocol constants, WOTS/XMSS/Winternitz types: `C:\Users\hemav\OneDrive\Desktop\mpcwallet\crates\vaulkyrie-protocol\src\lib.rs`
- Core instruction set: `C:\Users\hemav\OneDrive\Desktop\mpcwallet\programs\vaulkyrie-core\src\instruction.rs`
- Core transition/replay logic: `C:\Users\hemav\OneDrive\Desktop\mpcwallet\programs\vaulkyrie-core\src\transition.rs`
- Devnet program config: `C:\Users\hemav\OneDrive\Desktop\mpcwallet\Anchor.toml`

---

## External reference points used in the market pitch

- Chainalysis 2025 mid-year crypto crime update: https://www.chainalysis.com/blog/2025-crypto-crime-mid-year-update/
- Chainalysis 2025 crypto crime report intro: https://www.chainalysis.com/blog/2025-crypto-crime-report-introduction/
- Phantom Series C announcement: https://phantom.com/learn/blog/phantom-series-c
- Phantom coverage with the same metrics: https://siliconangle.com/2025/01/17/phantom-cryptocurrency-wallet-raises-150m-3b-valuation/
