//! Actual selected saved-view service seam. RED refuses before semantic adoption.
use crate::workspace_service::{
    authority,
    selected::{SelectedSavedViewFrame, SelectedSavedViewRequest},
    types::selected::{AuthorityError, AuthorityErrorKind},
};
use std::path::Path;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Native saved-view command integration follows causal service RED."
    )
)]
pub(crate) fn read_saved_view(
    _root: &Path,
    _path: &str,
    _request: &SelectedSavedViewRequest,
    _zone: chrono_tz::Tz,
    _today: chrono::NaiveDate,
) -> Result<SelectedSavedViewFrame, AuthorityError> {
    Err(authority::error(
        AuthorityErrorKind::UnsupportedOperation,
        "Canonical saved-view frames are unavailable.",
    ))
}

#[cfg(test)]
thread_local! {
    static BEFORE_PUBLISH:std::cell::RefCell<Option<Box<dyn FnOnce()>>>=std::cell::RefCell::new(None);
    static RESPONSE_LIMIT:std::cell::Cell<Option<usize>>=const {std::cell::Cell::new(None)};
}
#[cfg(test)]
pub(crate) fn with_saved_view_before_publish_for_test<T>(
    before: impl FnOnce() + 'static,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<Box<dyn FnOnce()>>);
    impl Drop for Reset {
        fn drop(&mut self) {
            BEFORE_PUBLISH.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(BEFORE_PUBLISH.with(|slot| slot.borrow_mut().replace(Box::new(before))));
    run()
}
#[cfg(test)]
pub(crate) fn with_saved_view_response_limit_for_test<T>(
    limit: usize,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<usize>);
    impl Drop for Reset {
        fn drop(&mut self) {
            RESPONSE_LIMIT.with(|slot| slot.set(self.0));
        }
    }
    let _reset = Reset(RESPONSE_LIMIT.with(|slot| slot.replace(Some(limit))));
    run()
}
