//! The proxy against a fake upstream: what reaches the key, what is answered here, and what the
//! limits refuse.

use axum::http::StatusCode;
use std::sync::Arc;

use axum::{Json, Router, body::Body, http::Request, routing::post};
use doku_rpc_proxy::{Config, HttpServer};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

/// An upstream that echoes every request's method as its result, so the test can see exactly
/// which requests were forwarded.
async fn fake_upstream() -> String {
    async fn echo(Json(body): Json<Value>) -> Json<Value> {
        let answer = |r: &Value| {
            json!({ "jsonrpc": "2.0", "id": r.get("id").cloned().unwrap_or(Value::Null),
                    "result": r.get("method").cloned().unwrap_or(Value::Null) })
        };
        match body {
            Value::Array(reqs) => Json(Value::Array(reqs.iter().map(answer).collect())),
            single => Json(answer(&single)),
        }
    }
    let app = Router::new().route("/", post(echo));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}/")
}

fn config(rpc_url: String) -> Config {
    Config {
        port: 0,
        rpc_url,
        expected_key: "k".into(),
        allowed_origins: vec!["https://doku.family".into()],
        trusted_hosts: vec![],
        per_ip_per_second: 1_000,
        per_ip_burst: 1_000,
        global_per_second: 10_000,
        global_burst: 10_000,
        max_batch: 3,
        max_body_bytes: 2_048,
        max_log_range: 100,
    }
}

async fn proxy() -> Router {
    let upstream = fake_upstream().await;
    HttpServer::router(Arc::new(HttpServer::new(config(upstream))))
}

fn request(path: &str, body: Value, origin: Option<&str>) -> Request<Body> {
    let mut b = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .header("x-forwarded-for", "203.0.113.7");
    if let Some(o) = origin {
        b = b.header("origin", o);
    }
    b.body(Body::from(body.to_string())).unwrap()
}

async fn json_of(res: axum::response::Response) -> Value {
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

fn rpc(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

#[tokio::test]
async fn relays_an_allowed_call_and_refuses_a_disallowed_one_with_a_json_rpc_error() {
    let app = proxy().await;
    let res = app.clone().oneshot(request("/public.k", rpc(1, "eth_call", json!([{}, "latest"])), None)).await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(json_of(res).await["result"], json!("eth_call"));

    let res = app.oneshot(request("/public.k", rpc(2, "debug_traceCall", json!([])), None)).await.unwrap();
    assert_eq!(res.status(), 200);
    let body = json_of(res).await;
    assert_eq!(body["error"]["code"], json!(-32601));
    assert_eq!(body["id"], json!(2));
}

#[tokio::test]
async fn a_batch_is_capped_and_its_refusals_are_answered_in_place() {
    let app = proxy().await;
    let batch = json!([
        rpc(1, "eth_chainId", json!([])),
        rpc(2, "trace_block", json!([])),
        rpc(3, "eth_blockNumber", json!([])),
    ]);
    let body = json_of(app.clone().oneshot(request("/public.k", batch, None)).await.unwrap()).await;
    let arr = body.as_array().unwrap();
    assert_eq!(arr.len(), 3);
    assert_eq!(arr[0]["result"], json!("eth_chainId"));
    assert_eq!(arr[1]["error"]["code"], json!(-32601));
    assert_eq!(arr[2]["result"], json!("eth_blockNumber"));

    let too_many = Value::Array((1..=4).map(|i| rpc(i, "eth_chainId", json!([]))).collect());
    let body = json_of(app.oneshot(request("/public.k", too_many, None)).await.unwrap()).await;
    assert_eq!(body["error"]["code"], json!(-32600));
}

#[tokio::test]
async fn a_wide_log_scan_is_refused_before_it_reaches_the_key() {
    let app = proxy().await;
    let wide = rpc(1, "eth_getLogs", json!([{ "fromBlock": "0x0", "toBlock": "0x1000" }]));
    let body = json_of(app.clone().oneshot(request("/public.k", wide, None)).await.unwrap()).await;
    assert_eq!(body["error"]["code"], json!(-32602));
    let narrow = rpc(1, "eth_getLogs", json!([{ "fromBlock": "0x0", "toBlock": "0x64" }]));
    let body = json_of(app.oneshot(request("/public.k", narrow, None)).await.unwrap()).await;
    assert_eq!(body["result"], json!("eth_getLogs"));
}

#[tokio::test]
async fn an_origin_this_deployment_does_not_serve_is_refused_and_no_origin_is_allowed() {
    let app = proxy().await;
    let res = app.clone().oneshot(request("/public.k", rpc(1, "eth_chainId", json!([])), Some("https://evil.example"))).await.unwrap();
    assert_eq!(res.status(), 403);
    let res = app.clone().oneshot(request("/public.k", rpc(1, "eth_chainId", json!([])), Some("https://doku.family"))).await.unwrap();
    assert_eq!(res.status(), 200);
    let res = app.oneshot(request("/public.k", rpc(1, "eth_chainId", json!([])), None)).await.unwrap();
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn the_wrong_key_and_an_oversized_body_are_refused() {
    let app = proxy().await;
    let res = app.clone().oneshot(request("/public.wrong", rpc(1, "eth_chainId", json!([])), None)).await.unwrap();
    assert_eq!(res.status(), 401);
    let fat = rpc(1, "eth_call", json!([{ "data": "0x".to_string() + &"ab".repeat(2_000) }, "latest"]));
    let res = app.oneshot(request("/public.k", fat, None)).await.unwrap();
    assert_eq!(res.status(), 413);
}

#[tokio::test]
async fn the_per_client_limit_is_keyed_on_the_forwarded_address() {
    let upstream = fake_upstream().await;
    let mut cfg = config(upstream);
    cfg.per_ip_per_second = 1;
    cfg.per_ip_burst = 2;
    let app = HttpServer::router(Arc::new(HttpServer::new(cfg)));
    let send = |ip: &'static str| {
        let app = app.clone();
        async move {
            let req = Request::builder()
                .method("POST")
                .uri("/public.k")
                .header("content-type", "application/json")
                .header("x-forwarded-for", ip)
                .body(Body::from(rpc(1, "eth_chainId", json!([])).to_string()))
                .unwrap();
            app.oneshot(req).await.unwrap()
        }
    };
    assert_eq!(send("198.51.100.1").await.status(), 200);
    assert_eq!(send("198.51.100.1").await.status(), 200);
    let third = send("198.51.100.1").await;
    assert_eq!(third.status(), 429);
    assert!(third.headers().contains_key("retry-after"));
    // A different client has its own bucket.
    assert_eq!(send("198.51.100.2").await.status(), 200);
}

#[tokio::test]
async fn health_answers_without_a_key() {
    let app = proxy().await;
    let res = app.oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), 200);
}


#[tokio::test]
async fn a_request_on_a_foreign_hostname_is_refused_when_hosts_are_trusted() {
    let upstream = fake_upstream().await;
    let mut cfg = config(upstream);
    cfg.trusted_hosts = vec!["rpc.doku.family".into()];
    let app = HttpServer::router(Arc::new(HttpServer::new(cfg)));
    let body = rpc(1, "eth_chainId", json!([]));
    let mut r = request("/public.k", body.clone(), None);
    r.headers_mut().insert("host", "doku-rpc-proxy-production.up.railway.app".parse().unwrap());
    assert_eq!(app.clone().oneshot(r).await.unwrap().status(), StatusCode::FORBIDDEN);
    let mut r = request("/public.k", body, None);
    r.headers_mut().insert("host", "rpc.doku.family".parse().unwrap());
    assert_eq!(app.oneshot(r).await.unwrap().status(), StatusCode::OK);
}

/// The limiter's replenish rate is the configured requests per second, not one per that many seconds.
#[tokio::test]
async fn the_bucket_refills_at_the_configured_rate() {
    let upstream = fake_upstream().await;
    let mut cfg = config(upstream);
    cfg.per_ip_per_second = 50;
    cfg.per_ip_burst = 5;
    let app = HttpServer::router(Arc::new(HttpServer::new(cfg)));
    let send = |app: Router| async move {
        let mut r = request("/public.k", rpc(1, "eth_chainId", json!([])), None);
        r.headers_mut().insert("x-forwarded-for", "198.51.100.42".parse().unwrap());
        app.oneshot(r).await.unwrap().status()
    };
    // The burst: five pass, the sixth is refused.
    for _ in 0..5 {
        assert_eq!(send(app.clone()).await, StatusCode::OK);
    }
    assert_eq!(send(app.clone()).await, StatusCode::TOO_MANY_REQUESTS);
    // At fifty per second, 200 ms refills about ten cells: the next request must pass. Under the
    // old reading (one cell every fifty SECONDS) it would still be refused.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(send(app.clone()).await, StatusCode::OK);
}
