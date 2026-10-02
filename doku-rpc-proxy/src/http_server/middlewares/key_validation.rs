use std::sync::Arc;

use axum::{
    extract::{Path, Request, State},
    middleware::Next,
    response::Response,
};
use reqwest::StatusCode;

use crate::http_server::HttpServer;

pub async fn validate_key(
    State(state): State<Arc<HttpServer>>,
    Path(key): Path<String>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if key != state.config.expected_key {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(req).await)
}
