//! The app's one window (M53.12).
//!
//! Tauri builds every `create: true` window itself, before `setup` runs, and
//! that path attaches no navigation hook and no new-window hook (tauri-2.11.5
//! app.rs:2524-2525). With no new-window hook WebKit gets no window back, so
//! every `target="_blank"` anchor, `window.open`, BlockNote's link toolbar and
//! tiptap's click handler was a dead click in the packaged app, and a plain
//! link was worse: nothing stopped it from taking the whole app off its page.
//! A plugin's `on_navigation` would see navigations but never a new-window
//! request.
//!
//! So `tauri.conf.json` declares the window `create: false`, and
//! `build_main_window` builds it here, from that same config, in `setup`,
//! with both of `links`'s routers attached. No other file builds a window:
//! `both_guards_are_attached` fails the build if one does.
//!
//! That entry also turns WebKit's background throttling off (M53.13). Two of
//! the app's clocks matter most while nobody is looking: `useJobRunner`'s 60 s
//! tick, the only way a due schedule gets noticed, and `useReminders`' 30 s
//! check, which exists to post a desktop notification. Tauri documents a
//! hidden view's timers being suspended after about five minutes. The key
//! reaches wry through `from_config`, and wry applies it on macOS 14 and
//! later only; `minimumSystemVersion` is still 10.15, so an older Mac keeps
//! WebKit's default. `the_main_window_keeps_running_hidden` says how to
//! measure it.

pub mod links;

/// The one window's label, and the only one `capabilities/default.json`
/// grants.
pub const MAIN_WINDOW: &str = "main";

/// Build the main window from its `tauri.conf.json` entry, with the link
/// guard attached. Called once, from `setup`.
///
/// The devUrl is the app's own origin only under `tauri dev`: tauri's own
/// app URL reads the same switch (`get_app_url`, tauri-2.11.5
/// manager/mod.rs:348-367), so in a packaged build it is just another web
/// address, and a link to it leaves for the browser like any other.
pub fn build_main_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .ok_or("tauri.conf.json declares no main window")?;
    let dev_root = if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let nav_root = dev_root.clone();
    let win_root = dev_root;
    tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
        .on_navigation(move |url| {
            links::route_navigation(url, nav_root.as_ref(), &links::open_in_browser)
        })
        .on_new_window(move |url, _features| {
            links::route_new_window(&url, win_root.as_ref(), &links::open_in_browser)
        })
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::links::{classify, LinkVerdict};
    use super::*;

    /// The shipped `tauri.conf.json`, parsed by tauri's own `Config`. Its
    /// window entries deny unknown keys, so a misspelt key or value fails
    /// here.
    fn shipped_config() -> tauri::Config {
        serde_json::from_str(include_str!("../../tauri.conf.json"))
            .expect("tauri.conf.json parses as tauri's own Config")
    }

    #[test]
    fn the_main_window_is_built_here_not_by_tauri() {
        let config = shipped_config();
        let windows = &config.app.windows;
        assert_eq!(windows.len(), 1, "one window, and this module builds it");
        assert_eq!(windows[0].label, MAIN_WINDOW);
        // With `create: true` tauri would build an unguarded window first,
        // and `build_main_window` would then fail on the taken label.
        assert!(
            !windows[0].create,
            "tauri.conf.json must not let tauri build the window"
        );

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!([MAIN_WINDOW]));

        // Each build's entry document is one the guard admits, or the app
        // would refuse to load itself. `tauri dev` boots the devUrl; a
        // packaged build boots `tauri://localhost`, because frontendDist is
        // a directory of assets rather than a URL to load.
        let dev = config
            .build
            .dev_url
            .as_ref()
            .expect("tauri.conf.json has a devUrl");
        assert_eq!(classify(dev, Some(dev)), LinkVerdict::Allow, "{dev}");
        assert!(matches!(
            config.build.frontend_dist,
            Some(tauri::utils::config::FrontendDist::Directory(_))
        ));
        let packaged: tauri::Url = "tauri://localhost".parse().unwrap();
        assert_eq!(classify(&packaged, None), LinkVerdict::Allow);
    }

    /// M53.13's setting ships, and the builder reads it. Only a packaged
    /// build shows it working, so measure by hand: in a scratch vault with
    /// Settings > Knowledge > "Learn on its own" on, give an agent
    /// `schedule: daily HH:MM` twelve minutes out and let its catch-up run
    /// finish. Hide the window (Cmd-M) at HH:MM minus 10 and restore it at
    /// HH:MM plus 3. The claim's `recorded_at` in runtime.db's `job_ledger`
    /// (ledger `skillRuns`, key `slug:<slug>`) should land within 1.5 min of
    /// its `run_key`, while the window was still hidden. The query is under
    /// M53.13 in docs/superpowers/plans/2026-10-12-m53-safe-core-and-rails.md.
    #[test]
    fn the_main_window_keeps_running_hidden() {
        let config = shipped_config();
        let main = config
            .app
            .windows
            .iter()
            .find(|window| window.label == MAIN_WINDOW)
            .expect("tauri.conf.json declares the main window");
        assert_eq!(
            main.background_throttling,
            Some(tauri::utils::config::BackgroundThrottlingPolicy::Disabled),
            "a hidden window must keep its timers running"
        );

        // tauri-runtime's `WebviewAttributes::from(&WindowConfig)` copies the
        // key, so a window built field by field would quietly drop it.
        let body = include_str!("mod.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("the non-test half");
        assert!(
            body.contains("WebviewWindowBuilder::from_config("),
            "build_main_window no longer builds from the config entry"
        );
    }

    #[test]
    fn both_guards_are_attached() {
        let here = include_str!("mod.rs");
        let body = here
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("the non-test half");
        for hook in [".on_navigation(", ".on_new_window("] {
            assert!(
                body.contains(hook),
                "build_main_window lost its {hook:?} hook"
            );
        }
        let lib = include_str!("../lib.rs");
        let lib_body = lib
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("lib.rs's non-test half");
        assert!(
            lib_body.contains("shell::build_main_window"),
            "lib.rs no longer builds the main window through the shell"
        );

        // Any other window or webview built anywhere would carry no guard.
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let me = src.join("shell").join("mod.rs");
        let mut scanned = 0;
        for entry in walkdir::WalkDir::new(&src) {
            let entry = entry.expect("src-tauri/src is readable");
            let path = entry.path();
            if path == me || path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            scanned += 1;
            let source = std::fs::read_to_string(path).expect("a source file reads");
            for builder in ["WindowBuilder", "WebviewBuilder"] {
                assert!(
                    !source.contains(builder),
                    "{} names {builder}: only shell::build_main_window builds a window",
                    path.display()
                );
            }
        }
        assert!(
            scanned > 50,
            "the scan is walking the real tree ({scanned} files)"
        );
    }
}
