//! Native selected-user/no-refresh gh acquisition. Public imports stay unavailable
//! until authenticated HTTPS identity/scope and original-owner integration land.
use super::{gh_credentials::GhTokenCommand, secrets::SecretValue, ConnectionError};
use crate::spawn::private_output::{PrivateOutput, CAPTURE_TIMEOUT_MS, PRIVATE_OUTPUT_LIMIT};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const RECIPE_REVISION: u32 = 1;
const RECIPE_ENVIRONMENT: [(&str, &str); 3] = [
    ("GH_PROMPT_DISABLED", "1"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("NO_COLOR", "1"),
];

#[derive(Clone, PartialEq, Eq)]
struct ExecutablePin {
    canonical: PathBuf,
    device: u64,
    inode: u64,
    bytes: u64,
    modified_seconds: i64,
    modified_nanos: i64,
}
struct GhNativeContext {
    executable: ExecutablePin,
    native_home: PathBuf,
    neutral_cwd: PathBuf,
}
struct GhCompatibility {
    executable: ExecutablePin,
    recipe_revision: u32,
}

fn absolute_context(context: &GhNativeContext) -> bool {
    context.executable.canonical.is_absolute()
        && context.native_home.is_absolute()
        && context.neutral_cwd.is_absolute()
}
fn configured_command(context: &GhNativeContext) -> Command {
    // Configuration only. Discovery, identity rechecks and launch belong to the
    // later trusted native owner; these paths are never inspected here.
    let mut command = crate::spawn::command(&context.executable.canonical);
    command
        .env_clear()
        .envs([
            ("GH_PROMPT_DISABLED", "1"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GH_NO_UPDATE_NOTIFIER", "1"),
            ("GH_SPINNER_DISABLED", "1"),
            ("NO_COLOR", "1"),
            ("CLICOLOR", "0"),
            ("GH_PAGER", ""),
            ("PAGER", ""),
            ("LC_ALL", "C"),
        ])
        .current_dir(&context.neutral_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}
fn compatibility_command(
    context: &GhNativeContext,
    empty_config: &Path,
) -> Result<Command, ConnectionError> {
    if !absolute_context(context) || !empty_config.is_absolute() {
        return Err(ConnectionError::Unavailable);
    }
    let mut command = configured_command(context);
    command
        .args(["auth", "token", "--help"])
        .env("HOME", empty_config)
        .env("GH_CONFIG_DIR", empty_config);
    Ok(command)
}
fn declared_required_flag(line: &str) -> Option<&str> {
    // In the supported Cobra form, long flags start at byte offset six:
    // six spaces, or two spaces plus a one-letter short alias and comma.
    // Keep this column intact so wrapped descriptions cannot declare flags.
    let prefix = line.as_bytes().get(..6)?;
    let no_alias = prefix == b"      ";
    let short_alias = prefix[0] == b' '
        && prefix[1] == b' '
        && prefix[2] == b'-'
        && prefix[3].is_ascii_alphanumeric()
        && prefix[4] == b','
        && prefix[5] == b' ';
    if !no_alias && !short_alias {
        return None;
    }
    let column = line.get(6..)?;
    if !column.starts_with("--") {
        return None;
    }
    // Cobra separates the declaration from its description with padding.
    let declaration = column.split_once("  ").map_or(column, |(head, _)| head);
    let mut tokens = declaration.split_ascii_whitespace();
    let option = tokens.next()?;
    match option {
        "--hostname" | "--user" if tokens.next() == Some("string") && tokens.next().is_none() => {
            Some(option)
        }
        "--no-refresh" if tokens.next().is_none() => Some(option),
        _ => None,
    }
}
fn accept_compatibility(
    context: &GhNativeContext,
    output: PrivateOutput,
) -> Result<GhCompatibility, ConnectionError> {
    let bytes = output.as_bytes();
    if !absolute_context(context) || bytes.is_empty() || bytes.len() > PRIVATE_OUTPUT_LIMIT {
        return Err(ConnectionError::Unsupported);
    }
    let help = std::str::from_utf8(bytes).map_err(|_| ConnectionError::Unsupported)?;
    if help
        .bytes()
        .any(|byte| (byte < b' ' && !matches!(byte, b'\n' | b'\r' | b'\t')) || byte == 0x7f)
    {
        return Err(ConnectionError::Unsupported);
    }
    let mut saw_flags = false;
    let mut in_flags = false;
    let mut required = [false; 3];
    for line in help.lines() {
        if line == "FLAGS" {
            if saw_flags {
                return Err(ConnectionError::Unsupported);
            }
            saw_flags = true;
            in_flags = true;
            continue;
        }
        if !in_flags || line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            in_flags = false;
            continue;
        }
        match declared_required_flag(line) {
            Some("--hostname") => required[0] = true,
            Some("--user") => required[1] = true,
            Some("--no-refresh") => required[2] = true,
            _ => {}
        }
    }
    if !saw_flags || !required.into_iter().all(|present| present) {
        return Err(ConnectionError::Unsupported);
    }
    Ok(GhCompatibility {
        executable: context.executable.clone(),
        recipe_revision: RECIPE_REVISION,
    })
}
fn token_command(
    context: &GhNativeContext,
    compatibility: &GhCompatibility,
    recipe: &GhTokenCommand,
) -> Result<Command, ConnectionError> {
    if recipe.program != "gh"
        || recipe.args.len() != 7
        || recipe.args[0] != "auth"
        || recipe.args[1] != "token"
        || recipe.args[2] != "--hostname"
        || recipe.args[3] != "github.com"
        || recipe.args[4] != "--user"
        || recipe.args[6] != "--no-refresh"
        || !recipe.clear_environment
        || recipe.environment.as_slice() != RECIPE_ENVIRONMENT.as_slice()
        || recipe.timeout_ms != CAPTURE_TIMEOUT_MS
        || recipe.output_limit != PRIVATE_OUTPUT_LIMIT
    {
        return Err(ConnectionError::InvalidSelection);
    }
    super::account_metadata::validate_account_login("github.com", &recipe.args[5])?;
    if !absolute_context(context)
        || compatibility.executable != context.executable
        || compatibility.recipe_revision != RECIPE_REVISION
    {
        return Err(ConnectionError::Unavailable);
    }
    let mut command = configured_command(context);
    command.args(&recipe.args).env("HOME", &context.native_home);
    Ok(command)
}
fn token_from_output(output: PrivateOutput) -> Result<SecretValue, ConnectionError> {
    let bytes = output.as_bytes();
    if bytes.is_empty() || bytes.len() > PRIVATE_OUTPUT_LIMIT {
        return Err(ConnectionError::Unavailable);
    }
    let end = if bytes.ends_with(b"\r\n") {
        bytes.len() - 2
    } else if bytes.ends_with(b"\n") {
        bytes.len() - 1
    } else {
        bytes.len()
    };
    if end == 0
        || end > super::secrets::MAX_SECRET_BYTES
        || !bytes[..end].iter().all(|byte| (0x21..=0x7e).contains(byte))
    {
        return Err(ConnectionError::Unavailable);
    }
    let mut owned = output.into_bytes();
    owned[end..].fill(0);
    owned.truncate(end);
    SecretValue::from_bytes(owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn context() -> GhNativeContext {
        GhNativeContext {
            executable: ExecutablePin {
                canonical: PathBuf::from("/private/tmp/cerebro-gh-contract/gh"),
                device: 1,
                inode: 2,
                bytes: 3,
                modified_seconds: 4,
                modified_nanos: 5,
            },
            native_home: PathBuf::from("/private/tmp/cerebro-gh-contract/native-home"),
            neutral_cwd: PathBuf::from("/private/tmp/cerebro-gh-contract/neutral"),
        }
    }
    fn recipe() -> GhTokenCommand {
        GhTokenCommand {
            program: "gh",
            args: [
                "auth",
                "token",
                "--hostname",
                "github.com",
                "--user",
                "alice",
                "--no-refresh",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            clear_environment: true,
            environment: vec![
                ("GH_PROMPT_DISABLED", "1"),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("NO_COLOR", "1"),
            ],
            timeout_ms: 15_000,
            output_limit: 16_384,
        }
    }
    fn env_is(command: &Command, key: &str, expected: &OsStr) -> bool {
        command
            .get_envs()
            .any(|(actual, value)| actual == key && value == Some(expected))
    }
    fn no_explicit_overrides(command: &Command) -> bool {
        let forbidden = [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GH_ENTERPRISE_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "GH_HOST",
            "GH_REPO",
            "GH_DEBUG",
            "DEBUG",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "XDG_CONFIG_HOME",
        ];
        !command
            .get_envs()
            .any(|(key, value)| value.is_some() && forbidden.iter().any(|f| key == *f))
    }
    fn safe_flags(command: &Command) -> bool {
        [
            ("GH_PROMPT_DISABLED", "1"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GH_NO_UPDATE_NOTIFIER", "1"),
            ("GH_SPINNER_DISABLED", "1"),
            ("NO_COLOR", "1"),
            ("CLICOLOR", "0"),
            ("GH_PAGER", ""),
            ("PAGER", ""),
            ("LC_ALL", "C"),
        ]
        .into_iter()
        .all(|(key, value)| env_is(command, key, OsStr::new(value)))
    }

    #[test]
    fn m96_gh_native_contract_selected_recipe_is_fixed() {
        let context = context();
        // Synthetic proof for the builder test only; the parser has its own case.
        let compatibility = GhCompatibility {
            executable: context.executable.clone(),
            recipe_revision: 1,
        };
        let built = token_command(&context, &compatibility, &recipe());
        assert!(
            built.is_ok(),
            "valid selected/no-refresh recipe must build without launching"
        );
        let built = built.unwrap();
        assert_eq!(
            built.get_program(),
            context.executable.canonical.as_os_str()
        );
        assert_eq!(
            built.get_args().collect::<Vec<_>>(),
            [
                "auth",
                "token",
                "--hostname",
                "github.com",
                "--user",
                "alice",
                "--no-refresh"
            ]
            .map(OsStr::new)
        );
        assert_eq!(built.get_current_dir(), Some(context.neutral_cwd.as_path()));
        assert!(env_is(&built, "HOME", context.native_home.as_os_str()));
        assert!(!built
            .get_envs()
            .any(|(key, value)| key == "GH_CONFIG_DIR" && value.is_some()));
        assert!(safe_flags(&built));
        assert!(no_explicit_overrides(&built));

        let empty = Path::new("/private/tmp/cerebro-gh-contract/empty-compatibility");
        let help = compatibility_command(&context, empty).expect("credential-free command shape");
        assert_eq!(help.get_program(), context.executable.canonical.as_os_str());
        assert_eq!(
            help.get_args().collect::<Vec<_>>(),
            ["auth", "token", "--help"].map(OsStr::new)
        );
        assert_eq!(help.get_current_dir(), Some(context.neutral_cwd.as_path()));
        assert!(env_is(&help, "HOME", empty.as_os_str()));
        assert!(env_is(&help, "GH_CONFIG_DIR", empty.as_os_str()));
        assert!(safe_flags(&help));
        assert!(no_explicit_overrides(&help));

        for alteration in 0..8 {
            let mut changed = recipe();
            match alteration {
                0 => {
                    changed.args.pop();
                }
                1 => changed.args[3] = "other.example".into(),
                2 => changed.args[5] = "--active".into(),
                3 => changed.program = "sh",
                4 => changed.clear_environment = false,
                5 => changed.timeout_ms = 15_001,
                6 => changed.output_limit = 16_385,
                _ => changed.environment.push(("GH_TOKEN", "synthetic-override")),
            }
            assert_eq!(
                token_command(&context, &compatibility, &changed).err(),
                Some(ConnectionError::InvalidSelection),
                "untrusted recipe alteration {alteration}"
            );
        }
        let mut changed_pin = context.executable.clone();
        changed_pin.inode += 1;
        let stale = GhCompatibility {
            executable: changed_pin,
            recipe_revision: 1,
        };
        assert!(
            token_command(&context, &stale, &recipe()).is_err(),
            "compatibility cannot move to another file identity"
        );
        // get_envs above inspects explicit configuration only. Actual env_clear,
        // null stdin/stderr and no inherited values require the later owned toy.
    }

    const HELP: &str = "Print the authentication token for a host and account.\n\nUSAGE\n  gh auth token [flags]\n\nFLAGS\n  -h, --hostname string   The hostname of the GitHub instance\n      --user string       The account login\n      --no-refresh        Disable automatic refresh\n\nINHERITED FLAGS\n      --help              Show help for command\n";

    #[test]
    fn m96_gh_native_contract_help_requires_real_option_declarations() {
        let context = context();
        let accepted =
            accept_compatibility(&context, PrivateOutput::synthetic(HELP.as_bytes().to_vec()));
        assert!(
            accepted.is_ok(),
            "bounded option declarations establish only advertised command shape"
        );
        let proof = accepted.unwrap();
        assert!(proof.executable == context.executable);
        assert_eq!(proof.recipe_revision, 1);
        let wrong = [
            String::new(),
            "--hostname --user --no-refresh are mentioned in prose only".to_owned(),
            HELP.replace("      --no-refresh        Disable automatic refresh\n", ""),
            HELP.replace("      --user string       The account login\n", ""),
            HELP.replace("FLAGS\n", "OPTIONS-IN-UNKNOWN-FORMAT\n"),
            "x".repeat(16_385),
            HELP.replace("  -h, --hostname string   The hostname of the GitHub instance\n", ""),
            concat!(
                "FLAGS\n",
                "      --unrelated string   Mentions --hostname --user --no-refresh in a description\n"
            )
            .to_owned(),
            concat!(
                "Mentions --hostname --user --no-refresh before the command section.\n\n",
                "FLAGS\n      --unrelated string   Not one of the required options\n"
            )
            .to_owned(),
            concat!(
                "FLAGS\n      --unrelated string   Not one of the required options\n\n",
                "INHERITED FLAGS\n",
                "  -h, --hostname string   The hostname\n",
                "      --user string       The login\n",
                "      --no-refresh        Disable refresh\n"
            )
            .to_owned(),
            concat!(
                "FLAGS\n      --unrelated string   Not one of the required options\n\n",
                "EXAMPLES\n  gh auth token --hostname github.com --user alice --no-refresh\n"
            )
            .to_owned(),
        ];
        for text in wrong {
            assert_eq!(
                accept_compatibility(&context, PrivateOutput::synthetic(text.into_bytes())).err(),
                Some(ConnectionError::Unsupported)
            );
        }
        assert_eq!(
            accept_compatibility(&context, PrivateOutput::synthetic(vec![0xff])).err(),
            Some(ConnectionError::Unsupported)
        );
        let continuation_only = concat!(
            "FLAGS\n",
            "  -h, --hostname string   The hostname\n",
            "      --user string       The account login\n",
            "      --unrelated string  Description continues:\n",
            "                          --no-refresh\n"
        );
        assert_eq!(
            accept_compatibility(
                &context,
                PrivateOutput::synthetic(continuation_only.as_bytes().to_vec())
            )
            .err(),
            Some(ConnectionError::Unsupported),
            "a description continuation cannot declare --no-refresh"
        );
    }

    #[test]
    fn m96_gh_native_contract_token_shape_stays_in_owned_bytes() {
        let valid = [
            (b"synthetic_A-1".to_vec(), b"synthetic_A-1".to_vec()),
            (b"synthetic_A-1\n".to_vec(), b"synthetic_A-1".to_vec()),
            (b"synthetic_A-1\r\n".to_vec(), b"synthetic_A-1".to_vec()),
            (vec![b'x'; 16_384], vec![b'x'; 16_384]),
        ];
        for (bytes, expected) in valid {
            let result = token_from_output(PrivateOutput::synthetic(bytes));
            assert!(
                result.is_ok(),
                "a supported synthetic token shape must be accepted"
            );
            let token = result.unwrap();
            assert!(
                token.expose() == expected,
                "compare privately without formatting secret bytes"
            );
        }
        let mut over_with_newline = vec![b'x'; 16_384];
        over_with_newline.push(b'\n');
        let invalid = [
            Vec::new(),
            b" ".to_vec(),
            b" x".to_vec(),
            b"x ".to_vec(),
            b"x\ty".to_vec(),
            b"x\0y".to_vec(),
            b"x\ny".to_vec(),
            b"x\ry".to_vec(),
            b"x\n\n".to_vec(),
            b"x\r".to_vec(),
            vec![0x7f],
            vec![0xff],
            vec![b'x'; 16_385],
            over_with_newline,
        ];
        for bytes in invalid {
            assert_eq!(
                token_from_output(PrivateOutput::synthetic(bytes)).err(),
                Some(ConnectionError::Unavailable)
            );
        }
    }
}

/// Only executable/config rechecks and the private child channel cross this seam.
/// Tests substitute those boundaries; recipe/help/token validation stays real.
trait GhExecutor {
    fn revalidate(&self, context: &GhNativeContext) -> Result<(), ConnectionError>;
    fn capture(
        &self,
        command: &mut Command,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<PrivateOutput, ConnectionError>;
}

fn check_cancelled(cancelled: &dyn Fn() -> bool) -> Result<(), ConnectionError> {
    if cancelled() { Err(ConnectionError::Cancelled) } else { Ok(()) }
}

fn capture_selected(
    context: &GhNativeContext,
    empty_config: &Path,
    recipe: &GhTokenCommand,
    executor: &dyn GhExecutor,
    cancelled: &dyn Fn() -> bool,
) -> Result<SecretValue, ConnectionError> {
    check_cancelled(cancelled)?;
    // Validate the entire selected recipe before launching even credential-free
    // help. This provisional value authorizes no launch; actual compatibility
    // below must come from this exact executable's bounded help result.
    let provisional = GhCompatibility {
        executable: context.executable.clone(),
        recipe_revision: RECIPE_REVISION,
    };
    let _ = token_command(context, &provisional, recipe)?;
    executor.revalidate(context)?;
    check_cancelled(cancelled)?;
    let help = executor.capture(&mut compatibility_command(context, empty_config)?, cancelled)?;
    check_cancelled(cancelled)?;
    let compatibility = accept_compatibility(context, help)?;
    // A binary/config/home replacement invalidates the selected attempt. Never
    // rediscover or fall back to a different executable/account on this path.
    executor.revalidate(context)?;
    check_cancelled(cancelled)?;
    let output = executor.capture(&mut token_command(context, &compatibility, recipe)?, cancelled)?;
    check_cancelled(cancelled)?;
    executor.revalidate(context)?;
    check_cancelled(cancelled)?;
    token_from_output(output)
}

/// Native-only process adapter. Construction does no I/O; the caller supplies
/// cancellation from the retained original owner/attempt, never a wire field.
pub(crate) struct NativeGhProcess {
    cancelled: Box<dyn Fn() -> bool + Send>,
}

#[path = "gh_native_platform.rs"]
mod platform;

#[cfg(test)]
#[path = "gh_adapter_tests.rs"]
mod adapter_tests;
