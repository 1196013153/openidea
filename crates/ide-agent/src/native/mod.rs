//! Agents driven over their own protocol rather than ACP: `codex app-server` and Claude
//! Code's stream-json mode. Each runs behind an in-process ACP endpoint (a shim), so a
//! task drives every agent the same way and reads what it can do from `initialize`.
//!
//! A shim speaks ACP v1 as the agent side, plus:
//! - `agentCapabilities.sessionCapabilities.fork` and `session/fork`
//!   (`{ sessionId, cwd, mcpServers }` → a `session/new` result for the copy);
//! - `agentCapabilities._meta.openidea.rollback` and `_openidea/rollback`
//!   (`{ sessionId, turns }`: drops the last `turns` user turns from the session);
//! - `agentCapabilities._meta.openidea.steer` and `_openidea/steer`
//!   (`{ sessionId, prompt }`: adds ACP content blocks to the running turn; fails when
//!   no turn runs).

pub(crate) mod claude;
pub(crate) mod codex;

use ide_jsonrpc::{Framing, Handler, Peer};
use std::sync::Arc;

/// The agent side of an in-process ACP connection.
pub(crate) trait Shim: Handler {
    /// Called once, before any message arrives: the connection to the client, for
    /// `session/update` notifications and `session/request_permission` requests.
    fn attach(&self, client: Peer);
}

/// Connects `client` to `shim`; returns the client's side. When the client goes away the
/// shim's connection closes (`Peer::closed`); a shim closes the client's by killing its
/// own side (`Peer::kill`) when its process exits.
pub(crate) fn serve<S: Shim>(shim: Arc<S>, client: Arc<dyn Handler>) -> Peer {
    let (ours, theirs) = tokio::io::duplex(1 << 20);
    let (or, ow) = tokio::io::split(ours);
    let (tr, tw) = tokio::io::split(theirs);
    let to_client = Peer::connect_framed(tr, tw, shim.clone(), Framing::Lines);
    shim.attach(to_client);
    Peer::connect_framed(or, ow, client, Framing::Lines)
}
