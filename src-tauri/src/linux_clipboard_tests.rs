use super::*;
use std::os::unix::fs::PermissionsExt;

const PAYLOAD: &str = "<prompt>synthetic 中文 🦀</prompt>\n\n";

#[test]
fn trusted_nested_tools_preserve_session_and_payload() {
    const HELPER_ENV: &str = "XML_PROMPT_STUDIO_TEST_HELPER";
    if let Some(helper) = std::env::var_os(HELPER_ENV) {
        let helper = PathBuf::from(helper);
        spawn_linux_helper(
            "wl-copy-fixture",
            &[helper.to_str().expect("fixture path is UTF-8")],
            &WL_COPY_TEXT_ARGS,
            PAYLOAD.as_bytes(),
        )
        .expect("the real helper path must use trusted nested tools");
        return;
    }

    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after Unix epoch")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "xml-prompt-studio-linux-helper-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir(&dir).expect("create isolated fixture directory");
    let shim_dir = dir.join("untrusted-path");
    fs::create_dir(&shim_dir).expect("create untrusted helper directory");
    let helper = dir.join("clipboard-helper");
    let output = dir.join("synthetic-payload");
    let marker = dir.join("untrusted-cat-ran");
    write_executable(
        &helper,
        r#"#!/bin/sh
test "$#" -eq 2 || exit 91
test "$1" = '--type' || exit 91
test "$2" = 'text/plain;charset=utf-8' || exit 91
test "$WAYLAND_DISPLAY" = 'synthetic-wayland' || exit 92
test "$XDG_RUNTIME_DIR" = '/synthetic/runtime' || exit 92
test "$DISPLAY" = ':synthetic' || exit 92
test "$DBUS_SESSION_BUS_ADDRESS" = 'synthetic-session-bus' || exit 92
cat > "$XML_PROMPT_STUDIO_TEST_OUTPUT"
"#,
    );
    write_executable(
        &shim_dir.join("cat"),
        r#"#!/bin/sh
printf 'untrusted cat ran' > "$XML_PROMPT_STUDIO_TEST_MARKER"
exit 93
"#,
    );

    let set_fixture_environment = |command: &mut Command| {
        command
            .env("PATH", &shim_dir)
            .env("WAYLAND_DISPLAY", "synthetic-wayland")
            .env("XDG_RUNTIME_DIR", "/synthetic/runtime")
            .env("DISPLAY", ":synthetic")
            .env("DBUS_SESSION_BUS_ADDRESS", "synthetic-session-bus")
            .env("XML_PROMPT_STUDIO_TEST_OUTPUT", &output)
            .env("XML_PROMPT_STUDIO_TEST_MARKER", &marker);
    };

    // The control proves the fixture actually intercepts a nested PATH lookup.
    let mut unprotected = Command::new(&helper);
    unprotected.args(WL_COPY_TEXT_ARGS).stdin(Stdio::null());
    set_fixture_environment(&mut unprotected);
    assert_eq!(
        unprotected.status().expect("run control helper").code(),
        Some(93)
    );
    assert!(marker.is_file());
    fs::remove_file(&marker).expect("clear synthetic interception marker");

    // Re-enter only this test with an inherited hostile PATH; no global process
    // environment is changed, and the helper never contacts a real clipboard.
    let mut protected = Command::new(std::env::current_exe().expect("resolve test executable"));
    protected
        .args([
            "--exact",
            "linux_clipboard_tests::trusted_nested_tools_preserve_session_and_payload",
            "--nocapture",
        ])
        .env(HELPER_ENV, &helper);
    set_fixture_environment(&mut protected);
    let result = protected.output().expect("run protected helper test");
    let payload = fs::read(&output).expect("read captured synthetic payload");
    let intercepted = marker.exists();
    fs::remove_dir_all(&dir).expect("remove isolated fixture directory");

    assert!(
        result.status.success(),
        "protected helper failed: {} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!intercepted, "untrusted nested tool must never execute");
    assert_eq!(
        payload,
        PAYLOAD.as_bytes(),
        "preserve UTF-8 and trailing newlines"
    );
}

fn write_executable(path: &Path, contents: &str) {
    fs::write(path, contents).expect("write synthetic helper");
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .expect("mark synthetic helper executable");
}
