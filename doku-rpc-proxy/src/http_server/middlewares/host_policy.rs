//! The proxy answers on its own name and no other.
//!
//! Railway gives every service a `*.up.railway.app` domain that bypasses Cloudflare. A request
//! that arrives that way can carry any `cf-connecting-ip` it likes and would be charged to a
//! fresh bucket each time, which is the per-client limiter bypassed. When `TRUSTED_HOSTS` is set
//! (`rpc.doku.family` in production), a request whose `Host` is not on the list is refused with
//! 403 before anything is counted or relayed. Unset means no check, which is the local and test
//! case. `/health` is outside this policy so a platform healthcheck on the internal name works.

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{StatusCode, header::HOST},
    middleware::Next,
    response::Response,
};

use crate::http_server::HttpServer;

pub async fn enforce_host(
    State(state): State<Arc<HttpServer>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let trusted = &state.config.trusted_hosts;
    if trusted.is_empty() {
        return Ok(next.run(req).await);
    }
    let host = req
        .headers()
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| h.split(':').next().unwrap_or(h).trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !trusted.iter().any(|t| t.eq_ignore_ascii_case(&host)) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(req).await)
}
