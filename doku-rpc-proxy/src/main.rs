#[tokio::main]
async fn main() {
    let http_server = doku_rpc_proxy::init()
        .await
        .expect("failed to initialize server");
    http_server
        .start()
        .await
        .expect("failed to start HTTP server");
}
