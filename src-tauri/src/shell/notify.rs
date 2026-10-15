//! Notification Center's one door (M64.6). Unbundled processes never call UN:
//! Apple's currentNotificationCenter can raise an Objective-C exception there.
//! Permission is read honestly; only the Settings action asks, and neither
//! request nor delivery asks for a Dock badge.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    Allowed,
    Quiet,
    Denied,
    NotAsked,
    Unknown,
}
impl Permission {
    pub fn word(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::Quiet => "quiet",
            Self::Denied => "denied",
            Self::NotAsked => "not-asked",
            Self::Unknown => "unknown",
        }
    }
}
fn from_status(status: isize) -> Permission {
    match status {
        0 => Permission::NotAsked,
        1 => Permission::Denied,
        2 => Permission::Allowed,
        3 => Permission::Quiet,
        _ => Permission::Unknown,
    }
}
#[cfg(any(target_os = "macos", test))]
fn is_bundled(identifier: Option<&str>, bundle_path: &str, expected: &str) -> bool {
    !expected.is_empty()
        && identifier == Some(expected)
        && std::path::Path::new(bundle_path)
            .extension()
            .is_some_and(|ext| ext == "app")
}
#[cfg(any(target_os = "macos", test))]
fn capped(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
        UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    };
    use std::{ptr::NonNull, sync::mpsc::sync_channel, time::Duration};

    fn bundled(expected: &str) -> bool {
        let bundle = NSBundle::mainBundle();
        let identifier = bundle.bundleIdentifier().map(|id| id.to_string());
        is_bundled(
            identifier.as_deref(),
            &bundle.bundlePath().to_string(),
            expected,
        )
    }
    pub fn permission(expected: &str) -> Permission {
        if !bundled(expected) {
            return Permission::Unknown;
        }
        let (send, recv) = sync_channel(1);
        let callback = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: UN passes a non-null settings object retained for this
            // callback. Read only its integer status before the callback ends.
            let status = unsafe { settings.as_ref() }.authorizationStatus().0;
            let _ = send.try_send(from_status(status));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .getNotificationSettingsWithCompletionHandler(&callback);
        recv.recv_timeout(Duration::from_secs(2))
            .unwrap_or(Permission::Unknown)
    }
    pub fn request(expected: &str) -> Permission {
        let current = permission(expected);
        if current != Permission::NotAsked {
            return current;
        }
        let (send, recv) = sync_channel(1);
        let callback = RcBlock::new(move |_allowed: Bool, error: *mut NSError| {
            let _ = send.try_send(error.is_null());
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &callback,
            );
        if recv.recv_timeout(Duration::from_secs(120)) != Ok(true) {
            return Permission::Unknown;
        }
        permission(expected)
    }
    pub fn post(expected: &str, id: &str, title: &str, body: &str) -> &'static str {
        let current = permission(expected);
        if !matches!(current, Permission::Allowed | Permission::Quiet) {
            return current.word();
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&capped(title, 120)));
        content.setBody(&NSString::from_str(&capped(body, 400)));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&capped(id, 256)),
            &content,
            None,
        );
        let (send, recv) = sync_channel(1);
        let callback = RcBlock::new(move |error: *mut NSError| {
            let _ = send.try_send(error.is_null());
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&callback));
        if recv.recv_timeout(Duration::from_secs(2)) == Ok(true) {
            "posted"
        } else {
            "failed"
        }
    }
}
#[cfg(target_os = "macos")]
pub use native::{permission, post, request};
#[cfg(not(target_os = "macos"))]
pub fn permission(_: &str) -> Permission {
    from_status(-1)
}
#[cfg(not(target_os = "macos"))]
pub fn request(_: &str) -> Permission {
    Permission::Unknown
}
#[cfg(not(target_os = "macos"))]
pub fn post(_: &str, _: &str, _: &str, _: &str) -> &'static str {
    "unknown"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_statuses_never_read_as_allowed() {
        assert_eq!(from_status(0), Permission::NotAsked);
        assert_eq!(from_status(1), Permission::Denied);
        assert_eq!(from_status(2), Permission::Allowed);
        assert_eq!(from_status(3), Permission::Quiet);
        for status in [-1, 4, 5, 999] {
            assert_eq!(from_status(status), Permission::Unknown);
        }
    }
    #[test]
    fn only_the_app_bundle_counts_as_bundled() {
        assert!(!is_bundled(
            None,
            "/Applications/Cerebro.app",
            "com.cerebro.app"
        ));
        assert!(!is_bundled(
            Some("other"),
            "/Applications/Cerebro.app",
            "com.cerebro.app"
        ));
        assert!(!is_bundled(
            Some("com.cerebro.app"),
            "/tmp/cerebro",
            "com.cerebro.app"
        ));
        assert!(!is_bundled(
            Some("com.cerebro.app"),
            "/tmp/Cerebro.app/Contents",
            "com.cerebro.app"
        ));
        assert!(is_bundled(
            Some("com.cerebro.app"),
            "/Applications/Cerebro.app",
            "com.cerebro.app"
        ));
    }
    #[test]
    fn an_unbundled_process_reads_unknown_without_asking_macos() {
        assert_eq!(permission("com.cerebro.app"), Permission::Unknown);
        assert_eq!(request("com.cerebro.app"), Permission::Unknown);
    }
    #[test]
    fn an_unbundled_post_never_reaches_macos() {
        assert_eq!(
            post("com.cerebro.app", "test", "Reminder", "Due"),
            "unknown"
        );
    }
    #[test]
    fn text_is_capped_by_characters() {
        assert_eq!(capped("a🦀é中z", 4), "a🦀é中");
        assert_eq!(capped("long", 0), "");
    }
}
