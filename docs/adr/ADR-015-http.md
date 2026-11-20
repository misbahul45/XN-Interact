# ADR-015: Streamable HTTP transport

Status: **Accepted: stays disabled in release 1.** Task P10-07, requirement CORE-08 (SHOULD).

## Decision

XN-Interact serves MCP over stdio only. No HTTP listener exists, except the transient loopback OAuth callback that opens when a connection attempt starts and closes after ten idle minutes.

## Why

- One owner on one machine. Every host (Claude Code, Codex and the other nine configured hosts) spawns its own stdio process; shared state is safe because the database uses WAL, immutable plans, atomic step claims and per-run, per-grant leases (see the concurrency tests).
- An HTTP listener would add an authentication problem (who is calling), DNS-rebinding and `Origin`/`Host` validation, and a second place where credentials could leak, for no capability the owner needs.
- The threat model lists MCP client impersonation (T07); stdio's trust boundary is the OS process, and a test proves an idle server listens on no port.

## Conditions to enable it later

All of the following, each with a test, before any listener is added: authentication for every request that is not bound to the OS user, `Origin` and `Host` allowlists, loopback-only binding, per-client authorization, no token or approval material in any response, and a cross-client authorization test. A remote or multi-user deployment is out of scope (baseline section 18).
