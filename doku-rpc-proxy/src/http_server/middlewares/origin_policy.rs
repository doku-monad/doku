use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{StatusCode, header::ORIGIN},
    middleware::Next,
    response::Response,
};

use crate::http_server::HttpServer;

/// A browser names its origin; a named origin has to be one this deployment serves.
///
/// CORS alone only stops the browser from READING the answer — the request still reaches the
/// upstream and is billed. Refusing it here keeps a page on another domain from spending the
/// key. A request with no `Origin` (a server, a wallet's own RPC client, curl) is let through
/// and counted by the rate limiter like everything else.
pub async fn enforce_origin(
    State(state): State<Arc<HttpServer>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if let Some(origin) = req.headers().get(ORIGIN) {
        let origin = origin.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        if !state.config.allowed_origins.iter().any(|o| o == origin) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(next.run(req).await)
}
