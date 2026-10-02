use anyhow::Context;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

pub use crate::{config::Config, http_server::HttpServer};

mod config;
pub mod http_server;

pub async fn init() -> anyhow::Result<HttpServer> {
    let config = init_config().context("failed to initialize config")?;

    Ok(HttpServer::new(config))
}

fn init_config() -> anyhow::Result<Config> {
    let config = Config::load().context("failed to load config")?;
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().pretty())
        .with(EnvFilter::from_default_env())
        .init();
    Ok(config)
}
