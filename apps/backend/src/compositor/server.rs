use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

// Frame transport: localhost WebSocket pushing the latest composited frame as one
// binary message (16-byte header + tight RGBA). watch-channel semantics drop
// stale frames for slow clients instead of queueing them.
//
// Header (little-endian): u32 magic "MOTN", u16 w, u16 h, f32 timeline_t, f32 render_fps

pub const MAGIC: u32 = 0x4D4F544E;

pub fn port() -> u16 {
    std::env::var("MOTIONAIRE_WS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(43117)
}

pub fn frame_message(w: u16, h: u16, t: f32, fps: f32, rgba: &[u8]) -> Bytes {
    let mut buf = Vec::with_capacity(16 + rgba.len());
    buf.extend_from_slice(&MAGIC.to_le_bytes());
    buf.extend_from_slice(&w.to_le_bytes());
    buf.extend_from_slice(&h.to_le_bytes());
    buf.extend_from_slice(&t.to_le_bytes());
    buf.extend_from_slice(&fps.to_le_bytes());
    buf.extend_from_slice(rgba);
    Bytes::from(buf)
}

pub async fn run(
    rx: watch::Receiver<Bytes>,
    client_count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
) {
    let port = port();
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("compositor ws: bind failed on {port}: {e}");
            return;
        }
    };
    log::info!("compositor ws: listening on ws://127.0.0.1:{port}");
    loop {
        let Ok((stream, peer)) = listener.accept().await else {
            continue;
        };
        let mut rx = rx.clone();
        let count = client_count.clone();
        tokio::spawn(async move {
            let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                return;
            };
            log::info!("compositor ws: client connected from {peer}");
            count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let (mut sink, mut source) = ws.split();
            // Drain (and ignore) client messages so pings/close are processed.
            let reader = tokio::spawn(async move { while source.next().await.is_some() {} });
            loop {
                if rx.changed().await.is_err() {
                    break;
                }
                let frame = rx.borrow_and_update().clone();
                if frame.is_empty() {
                    continue;
                }
                if sink
                    .send(tokio_tungstenite::tungstenite::Message::Binary(frame))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            reader.abort();
            count.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            log::info!("compositor ws: client {peer} disconnected");
        });
    }
}
