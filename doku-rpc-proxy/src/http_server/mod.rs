use std::{net::SocketAddr, sync::Arc};

use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderValue, Method, header::CONTENT_TYPE},
    middleware,
    routing::{get, post},
};
use tokio::net::TcpListener;
use tower_governor::{
    GovernorLayer,
    governor::GovernorConfigBuilder,
    key_extractor::GlobalKeyExtractor,
};
use tower_http::cors::CorsLayer;

use crate::http_server::client_ip::ClientIpKeyExtractor;

use crate::{
    config::Config,
    http_server::{
        controllers::rpc_handler,
        middlewares::{host_policy, key_validation, origin_policy},
    },
};

pub mod client_ip;
mod controllers;
mod middlewares;
pub mod screening;

pub struct HttpServer {
    config: Config,
    http_client: reqwest::Client,
}

impl HttpServer {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
        }
    }

    /// The service, as one router: the limits outermost, then the origin check, the key, and
    /// the handler.
    ///
    /// Two governors, and the order matters. The GLOBAL bucket is the promise made to the
    /// upstream key — however many clients there are, this is the most it will ever see. The
    /// per-client bucket is keyed on the address Railway's edge reports (`x-forwarded-for`,
    /// falling back to the peer), which is why it works behind that edge where the peer address
    /// is the edge itself; keyed on the peer, every visitor shared one bucket and no abuser ever
    /// hit it.
    pub fn router(state: Arc<Self>) -> Router {
        let origins = state
            .config
            .allowed_origins
            .iter()
            .filter_map(|origin| origin.parse::<HeaderValue>().ok())
            .collect::<Vec<HeaderValue>>();

        let cors = CorsLayer::new()
            .allow_origin(origins)
            .allow_methods([Method::GET, Method::POST])
            .allow_headers([CONTENT_TYPE]);

        /*
         * `per_second(n)` in tower_governor is NOT "n per second": it is "replenish one cell every
         * n SECONDS". Read that way, the 20 req/s this was meant to be became one request every
         * twenty seconds after the burst — a visitor got sixty reads and then three a minute, and
         * only the frontend's fallback to the public RPC kept pages alive. The replenish interval
         * is one second divided by the rate.
         */
        let per_ip = GovernorConfigBuilder::default()
            .key_extractor(ClientIpKeyExtractor)
            .per_nanosecond(replenish_ns(state.config.per_ip_per_second))
            .burst_size(state.config.per_ip_burst)
            .use_headers()
            .finish()
            .expect("per-ip governor");
        let global = GovernorConfigBuilder::default()
            .key_extractor(GlobalKeyExtractor)
            .per_nanosecond(replenish_ns(state.config.global_per_second))
            .burst_size(state.config.global_burst)
            .use_headers()
            .finish()
            .expect("global governor");

        let rpc = Router::new()
            .route("/public.{key}", post(rpc_handler::handle_post))
            .layer(middleware::from_fn_with_state(
                Arc::clone(&state),
                key_validation::validate_key,
            ))
            .layer(middleware::from_fn_with_state(
                Arc::clone(&state),
                origin_policy::enforce_origin,
            ))
            .layer(middleware::from_fn_with_state(
                Arc::clone(&state),
                host_policy::enforce_host,
            ))
            .layer(DefaultBodyLimit::max(state.config.max_body_bytes))
            .layer(GovernorLayer::new(per_ip))
            .layer(GovernorLayer::new(global));

        Router::new()
            .route("/health", get(|| async { "ok" }))
            .merge(rpc)
            .layer(cors)
            .with_state(state)
    }

    pub async fn start(self) -> anyhow::Result<()> {
        tracing::info!("Starting HTTP server...");

        let state = Arc::new(self);
        let listener_address = format!("0.0.0.0:{}", state.config.port);
        let listener = TcpListener::bind(listener_address).await?;
        tracing::info!(
            "limits: {}/s burst {} per client, {}/s burst {} global, batch<={}, body<={}B, logs<={} blocks",
            state.config.per_ip_per_second,
            state.config.per_ip_burst,
            state.config.global_per_second,
            state.config.global_burst,
            state.config.max_batch,
            state.config.max_body_bytes,
            state.config.max_log_range
        );

        let app = Self::router(state);
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await?;

        tracing::info!("HTTP serve completed");
        Ok(())
    }
}


/// The interval after which the governor replenishes ONE cell, for a rate of `per_second`
/// requests per second. Never zero: a zero interval is rejected by the builder.
pub fn replenish_ns(per_second: u64) -> u64 {
    (1_000_000_000 / per_second.max(1)).max(1)
}

#[cfg(test)]
mod rate_tests {
    use super::replenish_ns;

    #[test]
    fn twenty_per_second_is_one_cell_every_fifty_milliseconds() {
        assert_eq!(replenish_ns(20), 50_000_000);
        assert_eq!(replenish_ns(300), 3_333_333);
        assert_eq!(replenish_ns(0), 1_000_000_000);
    }
}
