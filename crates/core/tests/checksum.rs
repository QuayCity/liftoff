//! LiftOff's checksum must equal what Flyway stores, or imported history shows every script as edited.
//! Expected values: tests/fixtures/checksum/expected.txt (black-box capture, see its header).

#[test]
fn matches_flyway_checksums() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/checksum");
    let expected = std::fs::read_to_string(dir.join("expected.txt")).unwrap();
    let mut wrong = Vec::new();
    for line in expected.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()) {
        let (file, sum) = line.split_once(' ').unwrap();
        let ours = liftoff_core::migration::checksum(&std::fs::read(dir.join(file)).unwrap());
        if ours != sum.parse::<i32>().unwrap() {
            wrong.push(format!("{file}: flyway {sum}, liftoff {ours}"));
        }
    }
    assert!(wrong.is_empty(), "checksum mismatches:\n{}", wrong.join("\n"));
}
