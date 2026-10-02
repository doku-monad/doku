//! What the proxy lets through to the upstream, decided before a byte is forwarded.
//!
//! The upstream is a metered key. Everything here exists to make sure only the calls the front
//! end actually makes reach it, at a size the key can afford: a method allowlist, a cap on how
//! many blocks one `eth_getLogs` may scan, and a cap on batch length. A rejected request gets a
//! JSON-RPC error of its own rather than a 500, so a client library reads it as an answer.

use serde_json::{Value, json};

/// The methods a viem/wagmi front end needs, plus the reads a wallet makes while it confirms.
/// Anything not here is refused, which is what keeps `debug_*`, `trace_*`, filters and
/// subscriptions off the metered key.
const ALLOWED_METHODS: &[&str] = &[
    "eth_call",
    "eth_chainId",
    "eth_blockNumber",
    "eth_getBalance",
    "eth_estimateGas",
    "eth_gasPrice",
    "eth_maxPriorityFeePerGas",
    "eth_feeHistory",
    "eth_getTransactionReceipt",
    "eth_getTransactionByHash",
    "eth_getTransactionCount",
    "eth_sendRawTransaction",
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_getLogs",
    "net_version",
    "web3_clientVersion",
];

/// Why a request was not forwarded, as the JSON-RPC error it becomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// `-32600`: not a JSON-RPC request object.
    InvalidRequest(String),
    /// `-32601`: a method this proxy does not relay.
    MethodNotAllowed(String),
    /// `-32602`: a method it relays, with parameters it will not (an unbounded log scan).
    InvalidParams(String),
}

impl Refusal {
    pub fn code(&self) -> i64 {
        match self {
            Refusal::InvalidRequest(_) => -32600,
            Refusal::MethodNotAllowed(_) => -32601,
            Refusal::InvalidParams(_) => -32602,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Refusal::InvalidRequest(m) | Refusal::MethodNotAllowed(m) | Refusal::InvalidParams(m) => m,
        }
    }

    /// The error response for the request that carried `id`.
    pub fn to_response(&self, id: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": self.code(), "message": self.message() },
        })
    }
}

/// The `id` of a request object, or `null` when it has none (the spec's answer for a request
/// that could not be read).
pub fn id_of(request: &Value) -> Value {
    request.get("id").cloned().unwrap_or(Value::Null)
}

/// A hex block number such as `"0x1a2b"`; `None` for a tag (`latest`, `earliest`, …) or junk.
pub fn parse_block(v: &Value) -> Option<u64> {
    let s = v.as_str()?;
    let hex = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    if hex.is_empty() {
        return None;
    }
    u64::from_str_radix(hex, 16).ok()
}

/// Whether one request object may be forwarded.
pub fn screen(request: &Value, max_log_range: u64) -> Result<(), Refusal> {
    let Some(obj) = request.as_object() else {
        return Err(Refusal::InvalidRequest("request is not an object".into()));
    };
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        return Err(Refusal::InvalidRequest("method is missing".into()));
    };
    if !ALLOWED_METHODS.contains(&method) {
        return Err(Refusal::MethodNotAllowed(format!("method {method} is not relayed")));
    }
    if method == "eth_getLogs" {
        screen_get_logs(obj.get("params"), max_log_range)?;
    }
    Ok(())
}

/// A log scan is bounded or it is refused: by `blockHash`, or by a numeric `fromBlock` with a
/// `toBlock` no more than `max_log_range` above it (`latest`/`pending` as the top is allowed,
/// because the node bounds that itself). `earliest`, an absent `fromBlock`, or a range wider
/// than the cap is the unbounded scan that empties a free tier in one call.
fn screen_get_logs(params: Option<&Value>, max_log_range: u64) -> Result<(), Refusal> {
    let filter = params
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_object)
        .ok_or_else(|| Refusal::InvalidParams("eth_getLogs needs a filter object".into()))?;
    if filter.contains_key("blockHash") {
        return Ok(());
    }
    let from = filter
        .get("fromBlock")
        .and_then(parse_block)
        .ok_or_else(|| Refusal::InvalidParams("eth_getLogs needs a numeric fromBlock".into()))?;
    match filter.get("toBlock") {
        None => Ok(()),
        Some(v) => match v.as_str() {
            Some("latest") | Some("pending") | Some("safe") | Some("finalized") => Ok(()),
            _ => {
                let to = parse_block(v).ok_or_else(|| {
                    Refusal::InvalidParams("eth_getLogs toBlock must be numeric or latest".into())
                })?;
                if to < from {
                    return Err(Refusal::InvalidParams("eth_getLogs toBlock is below fromBlock".into()));
                }
                if to - from > max_log_range {
                    return Err(Refusal::InvalidParams(format!(
                        "eth_getLogs range may span at most {max_log_range} blocks"
                    )));
                }
                Ok(())
            }
        },
    }
}

/// The batch as it will be forwarded and answered.
#[derive(Debug, Default)]
pub struct Screened {
    /// Positions in the original batch that may be forwarded, and the requests themselves.
    pub forward: Vec<(usize, Value)>,
    /// Positions that were refused, with the error each one gets back.
    pub refused: Vec<(usize, Value)>,
}

/// Screen every entry of a batch. The batch's length is checked by the caller.
pub fn screen_batch(batch: &[Value], max_log_range: u64) -> Screened {
    let mut out = Screened::default();
    for (i, req) in batch.iter().enumerate() {
        match screen(req, max_log_range) {
            Ok(()) => out.forward.push((i, req.clone())),
            Err(r) => out.refused.push((i, r.to_response(id_of(req)))),
        }
    }
    out
}

/// Put the upstream's answers back in the positions of the requests that produced them, with
/// the refusals in theirs. Answers are matched by `id`; an answer with no match (a node that
/// answered out of spec) is placed in order instead, so nothing is dropped.
pub fn merge_batch(len: usize, screened: Screened, mut upstream: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Option<Value>> = vec![None; len];
    for (i, err) in screened.refused {
        out[i] = Some(err);
    }
    for (i, req) in &screened.forward {
        let id = id_of(req);
        if let Some(pos) = upstream.iter().position(|r| r.get("id") == Some(&id)) {
            out[*i] = Some(upstream.remove(pos));
        }
    }
    let mut leftovers = upstream.into_iter();
    for (i, _) in &screened.forward {
        if out[*i].is_none() {
            out[*i] = leftovers.next();
        }
    }
    out.into_iter()
        .map(|v| {
            v.unwrap_or_else(|| {
                Refusal::InvalidRequest("no answer from upstream".into()).to_response(Value::Null)
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
    }

    #[test]
    fn relays_what_the_front_end_needs_and_nothing_else() {
        for m in [
            "eth_call",
            "eth_chainId",
            "eth_blockNumber",
            "eth_getBalance",
            "eth_estimateGas",
            "eth_getTransactionCount",
            "eth_sendRawTransaction",
            "eth_getTransactionReceipt",
            "eth_getBlockByNumber",
            "eth_feeHistory",
            "eth_maxPriorityFeePerGas",
            "eth_gasPrice",
            "eth_getCode",
        ] {
            assert_eq!(screen(&req(m, json!([])), 2000), Ok(()), "{m}");
        }
        for m in [
            "debug_traceTransaction",
            "trace_block",
            "admin_peers",
            "personal_sign",
            "txpool_content",
            "eth_subscribe",
            "eth_newFilter",
            "eth_getProof",
        ] {
            let r = screen(&req(m, json!([])), 2000).unwrap_err();
            assert_eq!(r.code(), -32601, "{m}");
        }
    }

    #[test]
    fn a_request_that_is_not_an_object_is_invalid() {
        assert_eq!(screen(&json!("x"), 2000).unwrap_err().code(), -32600);
        assert_eq!(screen(&json!({ "id": 1 }), 2000).unwrap_err().code(), -32600);
    }

    #[test]
    fn get_logs_is_bounded_by_the_range_cap() {
        let ok = req("eth_getLogs", json!([{ "fromBlock": "0x100", "toBlock": "0x8d0" }])); // 2000
        assert_eq!(screen(&ok, 2000), Ok(()));
        let wide = req("eth_getLogs", json!([{ "fromBlock": "0x100", "toBlock": "0x8d1" }])); // 2001
        assert_eq!(screen(&wide, 2000).unwrap_err().code(), -32602);
        let latest = req("eth_getLogs", json!([{ "fromBlock": "0x100", "toBlock": "latest" }]));
        assert_eq!(screen(&latest, 2000), Ok(()));
        let by_hash = req("eth_getLogs", json!([{ "blockHash": "0xabc" }]));
        assert_eq!(screen(&by_hash, 2000), Ok(()));
        let earliest = req("eth_getLogs", json!([{ "fromBlock": "earliest", "toBlock": "latest" }]));
        assert_eq!(screen(&earliest, 2000).unwrap_err().code(), -32602);
        let open = req("eth_getLogs", json!([{ "toBlock": "latest" }]));
        assert_eq!(screen(&open, 2000).unwrap_err().code(), -32602);
        let backwards = req("eth_getLogs", json!([{ "fromBlock": "0x200", "toBlock": "0x100" }]));
        assert_eq!(screen(&backwards, 2000).unwrap_err().code(), -32602);
        let bare = req("eth_getLogs", json!([]));
        assert_eq!(screen(&bare, 2000).unwrap_err().code(), -32602);
    }

    #[test]
    fn parses_hex_blocks_and_refuses_tags() {
        assert_eq!(parse_block(&json!("0x10")), Some(16));
        assert_eq!(parse_block(&json!("latest")), None);
        assert_eq!(parse_block(&json!("0x")), None);
        assert_eq!(parse_block(&json!(16)), None);
    }

    #[test]
    fn a_batch_is_split_into_what_goes_upstream_and_what_is_answered_here() {
        let batch = vec![
            json!({ "jsonrpc": "2.0", "id": "a", "method": "eth_chainId", "params": [] }),
            json!({ "jsonrpc": "2.0", "id": "b", "method": "trace_block", "params": [] }),
            json!({ "jsonrpc": "2.0", "id": "c", "method": "eth_blockNumber", "params": [] }),
        ];
        let s = screen_batch(&batch, 2000);
        assert_eq!(s.forward.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![0, 2]);
        assert_eq!(s.refused.len(), 1);
        assert_eq!(s.refused[0].0, 1);
        assert_eq!(s.refused[0].1["error"]["code"], json!(-32601));
        assert_eq!(s.refused[0].1["id"], json!("b"));

        // The upstream answers out of order; each answer lands under its own request.
        let upstream = vec![
            json!({ "jsonrpc": "2.0", "id": "c", "result": "0x2" }),
            json!({ "jsonrpc": "2.0", "id": "a", "result": "0x8f" }),
        ];
        let merged = merge_batch(3, s, upstream);
        assert_eq!(merged[0]["result"], json!("0x8f"));
        assert_eq!(merged[1]["error"]["code"], json!(-32601));
        assert_eq!(merged[2]["result"], json!("0x2"));
    }

    #[test]
    fn an_answer_without_an_id_is_placed_in_order_rather_than_dropped() {
        let batch = vec![
            json!({ "jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": [] }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "eth_chainId", "params": [] }),
        ];
        let s = screen_batch(&batch, 2000);
        let upstream = vec![json!({ "jsonrpc": "2.0", "result": "x" }), json!({ "jsonrpc": "2.0", "result": "y" })];
        let merged = merge_batch(2, s, upstream);
        assert_eq!(merged[0]["result"], json!("x"));
        assert_eq!(merged[1]["result"], json!("y"));
        let s2 = screen_batch(&batch, 2000);
        let merged2 = merge_batch(2, s2, vec![]);
        assert_eq!(merged2[1]["error"]["code"], json!(-32600));
    }
}
