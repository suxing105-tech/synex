//! Exercise the real Tauri updater against a loopback release feed, never install.
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

#[tokio::test]
async fn signed_download_rejects_tampering_and_ignores_older_releases() {
    for (version, tamper, expected_requests) in [
        ("99.0.0", false, 2),
        ("99.0.0", true, 2),
        ("0.0.0", false, 1),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let manifest = serde_json::json!({"version":version,"notes":"local verification",
            "platforms":{"windows-x86_64":{"url":format!("{origin}/update.exe"),
                "signature":include_str!("fixtures/update.txt.sig").trim()}}})
        .to_string();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut served = 0;
            while served < expected_requests && Instant::now() < deadline {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 8192];
                let n = socket.read(&mut request).unwrap();
                let body =
                    if String::from_utf8_lossy(&request[..n]).starts_with("GET /latest.json ") {
                        manifest.as_bytes().to_vec()
                    } else if tamper {
                        b"tampered package".to_vec()
                    } else {
                        include_bytes!("fixtures/update.txt").to_vec()
                    };
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                socket.write_all(&body).unwrap();
                served += 1;
            }
            assert_eq!(served, expected_requests);
        });
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": include_str!("fixtures/update.pub").trim(),
                "endpoints": [format!("{origin}/latest.json")],
                "dangerousInsecureTransportProtocol": true
            }),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updater = app
            .updater_builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let update = updater.check().await.unwrap();
        if version == "0.0.0" {
            assert!(update.is_none());
        } else {
            let result = update.unwrap().download(|_, _| {}, || {}).await;
            if tamper {
                assert!(
                    result.is_err(),
                    "tampered content must never become installable"
                );
            } else {
                assert_eq!(result.unwrap(), include_bytes!("fixtures/update.txt"));
            }
        }
        server.join().unwrap();
    }
}
