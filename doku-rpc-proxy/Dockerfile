# The proxy, built and run on one pinned Debian release.
#
# Railpack's Rust builder linked a binary that referenced glibc 2.38 symbols (`__isoc23_sscanf`,
# from aws-lc-sys built with the builder's toolchain) against a runtime image without them, and
# the deploy failed at link time on 2026-09-18. Building and running on the same bookworm base
# removes the mismatch: whatever the compiler sees is what the runtime has.
FROM rust:1.90-bookworm AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/doku-rpc-proxy /usr/local/bin/doku-rpc-proxy
ENV RUST_LOG=info
EXPOSE 8080
CMD ["doku-rpc-proxy"]
