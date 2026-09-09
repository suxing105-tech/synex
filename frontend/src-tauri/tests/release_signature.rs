use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};

#[test]
#[ignore = "requires a freshly built installer; run with SUXING_TEST_INSTALLER_PATH"]
fn built_installer_matches_embedded_public_key() {
    let path = std::env::var("SUXING_TEST_INSTALLER_PATH").expect("installer path is required");
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let key = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let signature = std::fs::read_to_string(format!("{path}.sig")).unwrap();
    let public =
        PublicKey::decode(&String::from_utf8(STANDARD.decode(key).unwrap()).unwrap()).unwrap();
    let signature =
        Signature::decode(&String::from_utf8(STANDARD.decode(signature.trim()).unwrap()).unwrap())
            .unwrap();
    let mut bytes = std::fs::read(path).unwrap();
    assert!(bytes.starts_with(b"MZ"));
    public
        .verify(&bytes, &signature, true)
        .expect("installer must match the public key embedded in this release");
    bytes[100] ^= 1;
    assert!(public.verify(&bytes, &signature, true).is_err());
}
