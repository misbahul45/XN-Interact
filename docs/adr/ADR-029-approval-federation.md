# ADR-029: Approval federation between XN-Interact and XN-Bridge

Status: Proposed (design only; not implemented in release 1). Task PB-15, requirement INT-10 (COULD).

## Context

Release 1 is dual-gate: a social write needs `xn-interact approve <id>` (binds the XN-Interact plan hash; enforced where the provider call happens) and, when coordinated by XN-Bridge, `xnbridge approve <id>` (binds the bridge execution record). Two terminal confirmations for one action is friction.

## Options

| Option | Single human step | Who can forge | Change needed |
|---|---|---|---|
| A. Keep dual gate | no | nobody without both keys | none |
| B. XN-Interact trusts XN-Bridge signatures | yes (`xnbridge approve`) | anyone holding the bridge approver key | XN-Interact verifies an Ed25519 statement whose `payload_digest` covers `{plan_id, plan_hash, account_ids, operation, content_digest, expires_at}` and whose key fingerprint matches a pinned `approver.pub`; the host passes the signed statement as data |
| C. XN-Bridge trusts XN-Interact approvals | yes (`xn-interact approve`) | anyone holding the vault master key | XN-Interact signs an approval statement; XN-Bridge verifies it in `execution_record begin` |
| D. One CLI that performs both | yes (one screen) | as A | `xn-interact approve --bridge <id>` shows one preview, then signs both with their own keys |

## Threats to settle before choosing

- B and C collapse two independent keys into one; a single key compromise authorizes social writes.
- The host relays the signed statement; it cannot forge it, but it can replay it. Each statement must be single-use (nonce consumed in the same transaction as the run creation) and expire.
- XN-Bridge unattended autonomy must never produce a statement XN-Interact accepts (statements are only produced by the human-terminal path).
- Key rotation: a rotated bridge key must invalidate outstanding statements.

## Recommendation

Option D first: it removes the friction without merging trust roots. Revisit B only if the owner wants XN-Bridge to be the single approval authority and accepts the single-key risk.
