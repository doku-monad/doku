use anyhow::Context;

/// Everything the proxy reads from its environment, validated at boot.
///
/// The limits have defaults sized for a browser front end: a market page fires a burst of a
/// few dozen reads on load and then polls a handful of calls a second, so 20/s with a burst of
/// 60 per client is roomy for one person and tight for a script. The global bucket caps what
/// the whole world can push through to the upstream key, which is the thing being protected.
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub rpc_url: String,
    pub expected_key: String,
    pub allowed_origins: Vec<String>,
    /// Hostnames this proxy answers RPC on; empty means any. See `middlewares::host_policy`.
    pub trusted_hosts: Vec<String>,
    /// Sustained requests per second and burst allowance for one client IP.
    pub per_ip_per_second: u64,
    pub per_ip_burst: u32,
    /// Sustained requests per second and burst allowance across every client together.
    pub global_per_second: u64,
    pub global_burst: u32,
    /// The most JSON-RPC requests one batch may carry.
    pub max_batch: usize,
    /// The largest request body accepted, in bytes.
    pub max_body_bytes: usize,
    /// The widest `fromBlock..toBlock` an `eth_getLogs` may ask for.
    pub max_log_range: u64,
}

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    match std::env::var(name) {
        Ok(raw) if !raw.is_empty() => raw
            .parse::<T>()
            .map_err(|e| anyhow::anyhow!("{name} is not valid: {e}")),
        _ => Ok(default),
    }
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let allowed_origins = std::env::var("ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let trusted_hosts = std::env::var("TRUSTED_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase())
            .collect();
        let config = Config {
            port: std::env::var("PORT").context("PORT not set")?.parse()?,
            rpc_url: std::env::var("RPC_URL").context("RPC_URL not set")?,
            expected_key: std::env::var("EXPECTED_KEY").context("EXPECTED_KEY not set")?,
            allowed_origins,
            trusted_hosts,
            per_ip_per_second: env_or("PER_IP_PER_SECOND", 20)?,
            per_ip_burst: env_or("PER_IP_BURST", 60)?,
            global_per_second: env_or("GLOBAL_PER_SECOND", 300)?,
            global_burst: env_or("GLOBAL_BURST", 600)?,
            max_batch: env_or("MAX_BATCH", 20)?,
            max_body_bytes: env_or("MAX_BODY_BYTES", 64 * 1024)?,
            max_log_range: env_or("MAX_LOG_RANGE", 2_000)?,
        };
        if config.per_ip_per_second == 0 || config.global_per_second == 0 {
            anyhow::bail!("rate limits must be above zero");
        }
        if config.max_batch == 0 || config.max_body_bytes == 0 {
            anyhow::bail!("MAX_BATCH and MAX_BODY_BYTES must be above zero");
        }
        Ok(config)
    }
}
