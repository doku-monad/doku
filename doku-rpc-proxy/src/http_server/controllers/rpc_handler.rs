use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode};
use serde_json::{Value, json};

use crate::http_server::{
    HttpServer,
    screening::{Refusal, id_of, merge_batch, screen, screen_batch},
};

/// One JSON-RPC request or batch, screened, forwarded, and answered in the client's shape.
///
/// A refused request is answered with a JSON-RPC error and a 200, the way a node answers an
/// unknown method, so viem and wallets read it as a response rather than a transport failure.
/// Only an upstream that cannot be reached or that answers something other than JSON is a 502.
pub async fn handle_post(
    State(state): State<Arc<HttpServer>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let max_log_range = state.config.max_log_range;
    match body {
        Value::Array(batch) => {
            if batch.is_empty() {
                return Ok(Json(
                    Refusal::InvalidRequest("empty batch".into()).to_response(Value::Null),
                ));
            }
            if batch.len() > state.config.max_batch {
                return Ok(Json(
                    Refusal::InvalidRequest(format!(
                        "batch may carry at most {} requests",
                        state.config.max_batch
                    ))
                    .to_response(Value::Null),
                ));
            }
            let len = batch.len();
            let screened = screen_batch(&batch, max_log_range);
            let upstream: Vec<Value> = if screened.forward.is_empty() {
                Vec::new()
            } else {
                let to_send: Vec<Value> = screened.forward.iter().map(|(_, r)| r.clone()).collect();
                match forward(&state, &Value::Array(to_send)).await? {
                    Value::Array(answers) => answers,
                    // A node answering a batch with a single error object: every forwarded
                    // request gets that error, so nothing is silently lost.
                    other => screened.forward.iter().map(|_| other.clone()).collect(),
                }
            };
            Ok(Json(Value::Array(merge_batch(len, screened, upstream))))
        }
        single => match screen(&single, max_log_range) {
            Ok(()) => Ok(Json(forward(&state, &single).await?)),
            Err(refusal) => Ok(Json(refusal.to_response(id_of(&single)))),
        },
    }
}

async fn forward(state: &HttpServer, body: &Value) -> Result<Value, StatusCode> {
    let response = state
        .http_client
        .post(&state.config.rpc_url)
        .json(body)
        .send()
        .await
        .map_err(|e| {
            tracing::error!("Rpc send error: {e}");
            StatusCode::BAD_GATEWAY
        })?;

    let status = response.status();
    let json: Value = response.json().await.map_err(|e| {
        tracing::error!("Rpc parse error ({status}): {e}");
        StatusCode::BAD_GATEWAY
    })?;
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        tracing::warn!("upstream is rate limiting: {}", json);
        return Ok(json!({
            "jsonrpc": "2.0",
            "id": body.get("id").cloned().unwrap_or(Value::Null),
            "error": { "code": -32005, "message": "upstream rate limited; retry shortly" },
        }));
    }
    Ok(json)
}
