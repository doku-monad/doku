//! Which address a request is charged to.
//!
//! The site sits behind Cloudflare, and Cloudflare sits in front of Railway's edge. Railway
//! rewrites `x-forwarded-for` to the address IT sees, which is a Cloudflare egress — so a limiter
//! keyed on that header put every visitor behind one Cloudflare point of presence into one
//! bucket, and a single busy market page could 429 the whole audience. Cloudflare carries the
//! real client in `cf-connecting-ip`; that is the key when present, and the forwarded-for chain
//! (then the peer) only when it is not, which is the local and test case.
//!
//! `cf-connecting-ip` is trustworthy only because the public path is Cloudflare's: the host policy
//! refuses requests that reach this process by any other name, so a client cannot forge the header
//! by connecting to the Railway domain directly.

use std::net::IpAddr;

use axum::http::Request;
use tower_governor::{GovernorError, key_extractor::KeyExtractor, key_extractor::SmartIpKeyExtractor};

pub const CF_CONNECTING_IP: &str = "cf-connecting-ip";

#[derive(Clone, Copy, Debug)]
pub struct ClientIpKeyExtractor;

impl ClientIpKeyExtractor {
    /// The address this request is charged to: Cloudflare's client first, then the smart chain.
    #[allow(clippy::result_large_err)]
    pub fn client_ip<T>(req: &Request<T>) -> Result<IpAddr, GovernorError> {
        if let Some(ip) = req
            .headers()
            .get(CF_CONNECTING_IP)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<IpAddr>().ok())
        {
            return Ok(ip);
        }
        SmartIpKeyExtractor.extract(req)
    }
}

impl KeyExtractor for ClientIpKeyExtractor {
    type Key = IpAddr;

    fn extract<T>(&self, req: &Request<T>) -> Result<Self::Key, GovernorError> {
        Self::client_ip(req)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;

    fn req(headers: &[(&str, &str)]) -> Request<Body> {
        let mut b = Request::builder().uri("/");
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        b.body(Body::empty()).unwrap()
    }

    #[test]
    fn cloudflare_client_beats_the_forwarded_chain() {
        let r = req(&[("cf-connecting-ip", "203.0.113.9"), ("x-forwarded-for", "172.16.0.1")]);
        assert_eq!(ClientIpKeyExtractor::client_ip(&r).unwrap(), "203.0.113.9".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn falls_back_to_the_first_forwarded_hop() {
        let r = req(&[("x-forwarded-for", "198.51.100.7, 172.16.0.1")]);
        assert_eq!(ClientIpKeyExtractor::client_ip(&r).unwrap(), "198.51.100.7".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn a_garbage_cloudflare_header_is_ignored() {
        let r = req(&[("cf-connecting-ip", "not-an-ip"), ("x-forwarded-for", "198.51.100.7")]);
        assert_eq!(ClientIpKeyExtractor::client_ip(&r).unwrap(), "198.51.100.7".parse::<IpAddr>().unwrap());
    }
}
