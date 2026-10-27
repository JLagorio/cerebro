//! Finite app IPC admission. Renderer format/Entry flags are never authority.
use super::{
    authority::{self, AuthorityContext},
    boundary,
    types::selected::*,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Command {
    command: String,
    scope: String,
    root_argument: Option<String>,
    selected_disposition: String,
    traversal: Option<Traversal>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetArgument {
    argument: String,
    kind: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Traversal {
    kind: String,
    argument: Option<String>,
    allow_empty: bool,
    #[serde(default)]
    targets: Vec<TargetArgument>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Table {
    native_commands: Vec<Command>,
}
fn commands() -> &'static [Command] {
    static TABLE: OnceLock<Table> = OnceLock::new();
    &TABLE
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../../shared/workspace/authority.v2.json"))
                .expect("native command authority table")
        })
        .native_commands
}
fn unsupported() -> AuthorityError {
    authority::error(
        AuthorityErrorKind::UnsupportedOperation,
        "This operation is unavailable for selected metadata workspaces.",
    )
}
fn malformed() -> AuthorityError {
    authority::error(
        AuthorityErrorKind::BindingUnavailable,
        "The requested workspace identity or path is unavailable.",
    )
}
#[derive(Debug)]
enum Scope {
    Global,
    Vault {
        path: PathBuf,
        selected_safe: bool,
        targets: Result<Vec<(String, bool)>, AuthorityError>,
    },
    Path(PathBuf),
    Paths(Vec<PathBuf>),
    Root {
        id: String,
        relative: Option<String>,
        recursive: bool,
    },
    Active {
        enabled: bool,
    },
    Unknown,
}
pub(crate) struct NativeRequest {
    scope: Scope,
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, AuthorityError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= authority::rules().limits.path_bytes)
        .ok_or_else(malformed)
}
pub(crate) fn request(
    command: &str,
    payload: &tauri::ipc::InvokeBody,
) -> Result<NativeRequest, AuthorityError> {
    let Some(row) = commands().iter().find(|row| row.command == command) else {
        return Ok(NativeRequest {
            scope: Scope::Unknown,
        });
    };
    // Proven global commands do not require a readable selected registry or payload.
    if row.selected_disposition == "global_allowed"
        || matches!(
            row.scope.as_str(),
            "dialog_destination" | "derived_demo_destinations"
        )
    {
        return Ok(NativeRequest {
            scope: Scope::Global,
        });
    }
    let tauri::ipc::InvokeBody::Json(args) = payload else {
        return Err(malformed());
    };
    let key = row.root_argument.as_deref().unwrap_or("");
    let scope = match row.scope.as_str() {
        "optional_vault_root" if args.get(key).is_none_or(Value::is_null) => Scope::Global,
        "vault_root" | "optional_vault_root" => Scope::Vault {
            path: PathBuf::from(string(args, key)?),
            selected_safe: row.selected_disposition != "unsupported_selected",
            targets: vault_targets(row.traversal.as_ref(), args),
        },
        "root_id" => {
            let traversal = row.traversal.as_ref().ok_or_else(malformed)?;
            let recursive = match traversal.kind.as_str() {
                "file" => false,
                "tree" => true,
                _ => return Err(malformed()),
            };
            if !recursive && traversal.allow_empty {
                return Err(malformed());
            }
            let relative = match traversal.argument.as_deref() {
                Some("path") => {
                    let path = args
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|path| {
                            path.len() <= authority::rules().limits.path_bytes
                                && (traversal.allow_empty || !path.is_empty())
                        })
                        .ok_or_else(malformed)?;
                    Some(path.to_owned())
                }
                None if recursive && !traversal.allow_empty => None,
                _ => return Err(malformed()),
            };
            Scope::Root {
                id: string(args, key)?.into(),
                relative,
                recursive,
            }
        }
        // A current-opening read always requires legacy authority. Renderer
        // fields such as enabled=false or vault cannot weaken that requirement.
        "active_root" if row.selected_disposition == "unsupported_selected" => {
            Scope::Active { enabled: true }
        }
        "active_root" => Scope::Active {
            enabled: args
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(malformed)?,
        },
        "absolute_destination" | "absolute_mount_root" | "absolute_source" => {
            Scope::Path(PathBuf::from(string(args, key)?))
        }
        "absolute_source_array" => {
            let paths = args
                .get(key)
                .and_then(Value::as_array)
                .ok_or_else(malformed)?;
            if paths.len() > authority::rules().limits.retained_entries {
                return Err(malformed());
            }
            Scope::Paths(
                paths
                    .iter()
                    .map(|v| v.as_str().map(PathBuf::from).ok_or_else(malformed))
                    .collect::<Result<_, _>>()?,
            )
        }
        _ => return Err(malformed()),
    };
    Ok(NativeRequest { scope })
}
fn vault_targets(
    traversal: Option<&Traversal>,
    args: &Value,
) -> Result<Vec<(String, bool)>, AuthorityError> {
    let traversal = traversal.ok_or_else(malformed)?;
    match traversal.kind.as_str() {
        "file" | "tree" => {
            let tree = traversal.kind == "tree";
            let path = match traversal.argument.as_deref() {
                Some(argument) => string(args, argument)?.to_owned(),
                None if tree => String::new(),
                _ => return Err(malformed()),
            };
            Ok(vec![(path, tree)])
        }
        "targets"
            if !traversal.targets.is_empty()
                && traversal.targets.len() <= authority::rules().limits.retained_entries =>
        {
            traversal
                .targets
                .iter()
                .map(|target| {
                    let tree = match target.kind.as_str() {
                        "file" => false,
                        "tree" => true,
                        _ => return Err(malformed()),
                    };
                    Ok((string(args, &target.argument)?.to_owned(), tree))
                })
                .collect()
        }
        _ => Err(malformed()),
    }
}
fn target(path: &Path) -> Result<PathBuf, AuthorityError> {
    boundary::target(path)
}
pub(crate) fn guard_external_write(
    context: &AuthorityContext,
    path: &Path,
) -> Result<(), AuthorityError> {
    // The installed workspace namespace is canonical authority even if its
    // registry disappears. Resolve both paths through their real ancestors so
    // aliases and nonexistent tails cannot bypass containment. Ancestor write
    // scopes are destructive intersections too; unrelated app-data stays usable.
    let destination = target(path)?;
    let metadata = target(&context.origin.join("workspaces"))?;
    let requested = boundary::lexical(path)?;
    let metadata_requested = boundary::lexical(&context.origin.join("workspaces"))?;
    if destination.starts_with(&metadata)
        || metadata.starts_with(&destination)
        || requested.starts_with(&metadata_requested)
        || metadata_requested.starts_with(&requested)
    {
        return Err(unsupported());
    }
    guard_path(context, path, true)
}
fn guard_path(context: &AuthorityContext, path: &Path, tree: bool) -> Result<(), AuthorityError> {
    boundary::guard(context, path, tree)
}
fn root_path(context: &AuthorityContext, id: &str) -> Result<PathBuf, AuthorityError> {
    if id == "0" {
        let bytes = authority::read_bounded(
            &context.origin,
            "config.json",
            authority::rules().limits.registry_bytes,
        )?;
        let config: crate::app_config::AppConfig =
            serde_json::from_slice(&bytes).map_err(|_| malformed())?;
        return config.last_vault.map(PathBuf::from).ok_or_else(malformed);
    }
    let bytes = authority::read_bounded(
        &context.origin,
        "roots.json",
        authority::rules().limits.registry_bytes,
    )?;
    let roots: Vec<crate::roots::Root> = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
    if roots.len() > authority::rules().limits.registry_bindings {
        return Err(malformed());
    }
    let matches: Vec<_> = roots.into_iter().filter(|r| r.id == id).collect();
    if matches.len() != 1 {
        return Err(malformed());
    }
    Ok(PathBuf::from(&matches[0].path))
}
pub(crate) fn guard_active_enable(context: &AuthorityContext) -> Result<(), AuthorityError> {
    if let Some(root) = context.active_root()? {
        if authority::resolve_with(context, &root)?.is_some() {
            return Err(unsupported());
        }
        guard_path(context, &root, true)?;
    }
    Ok(())
}
pub(crate) fn dispatch_checked<T>(
    context: &AuthorityContext,
    request: NativeRequest,
    handler: impl FnOnce() -> T,
) -> Result<T, AuthorityError> {
    match request.scope {
        Scope::Global => {}
        Scope::Unknown => guard_active_enable(context)?,
        Scope::Active { enabled: true } => guard_active_enable(context)?,
        Scope::Active { enabled: false } => {}
        Scope::Vault {
            path,
            selected_safe,
            targets,
        } => {
            if !path.is_absolute() {
                return Err(malformed());
            }
            if authority::resolve_with(context, &path)?.is_some() {
                if !selected_safe {
                    return Err(unsupported());
                }
            } else {
                let root = authority::canonical_root(&path)?;
                let mut scopes = Vec::new();
                for (relative, tree) in targets? {
                    let rel = Path::new(&relative);
                    if rel.is_absolute()
                        || rel.components().any(|c| {
                            !matches!(
                                c,
                                std::path::Component::Normal(_) | std::path::Component::CurDir
                            )
                        })
                    {
                        return Err(malformed());
                    }
                    let requested = path.join(rel);
                    let actual = target(&requested)?;
                    if !actual.starts_with(&root) {
                        return Err(malformed());
                    }
                    scopes.push((requested, tree));
                }
                boundary::guard_scopes(context, &scopes)?;
            }
        }
        Scope::Path(path) => guard_external_write(context, &path)?,
        Scope::Paths(paths) => {
            let scopes: Vec<_> = paths.into_iter().map(|path| (path, false)).collect();
            boundary::guard_scopes(context, &scopes)?;
        }
        Scope::Root {
            id,
            relative,
            recursive,
        } => {
            let requested_root = root_path(context, &id)?;
            let root = authority::canonical_root(&requested_root)?;
            if authority::resolve_with(context, &root)?.is_some() {
                return Err(unsupported());
            }
            if let Some(relative) = relative {
                if crate::files::bytes::rel_refusal(&id, &relative).is_some()
                    && !relative.is_empty()
                {
                    return Err(malformed());
                }
                let requested = requested_root.join(relative);
                let actual = target(&requested)?;
                if !actual.starts_with(&root) {
                    return Err(malformed());
                }
                guard_path(context, &requested, recursive)?;
            } else {
                guard_path(context, &requested_root, true)?;
            }
        }
    }
    Ok(handler())
}

/// The exact post-dialog publication seam used by all four actual export commands.
/// Legacy write errors stay strings; selected destination failures retain their envelope.
pub(crate) fn publish_export(
    context: &AuthorityContext,
    path: &Path,
    bytes: &[u8],
) -> Result<(), CommandReadError> {
    guard_external_write(context, path).map_err(CommandReadError::Authority)?;
    std::fs::write(path, bytes).map_err(|e| CommandReadError::Legacy(e.to_string()))
}
pub(crate) fn guard_demo_destinations(
    context: &AuthorityContext,
    paths: &[PathBuf],
) -> Result<(), CommandReadError> {
    for path in paths {
        guard_external_write(context, path).map_err(CommandReadError::Authority)?;
    }
    Ok(())
}
