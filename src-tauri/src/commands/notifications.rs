use chrono::{Local, Timelike};
use std::sync::atomic::Ordering;
use tauri::State;

use crate::clients::github::{self, Notification};
use crate::creds;
use crate::error::AppResult;
use crate::state::AppState;

/// Mirror the Settings "Desktop notifications" toggle into the poller, which
/// checks this flag before showing an OS alert for a newly-requested review.
#[tauri::command]
pub fn set_notifications_enabled(state: State<'_, AppState>, enabled: bool) {
    state
        .notify_enabled
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
}

/// Mirror which notification reasons (review_requested, mention, comment,
/// ci_activity, …) are allowed to raise a desktop alert.
#[tauri::command]
pub fn set_notification_reasons(state: State<'_, AppState>, reasons: Vec<String>) {
    if let Ok(mut r) = state.notify_reasons.lock() {
        *r = reasons.into_iter().collect();
    }
}

/// Mirror the desktop-poll interval (seconds), clamped to a sane range.
#[tauri::command]
pub fn set_poll_interval(state: State<'_, AppState>, secs: u64) {
    state
        .notify_poll_secs
        .store(secs.clamp(15, 3600), std::sync::atomic::Ordering::Relaxed);
}

/// Mirror the local quiet-hours window into the existing notification state.
#[tauri::command]
pub fn set_notification_quiet_hours(
    state: State<'_, AppState>,
    enabled: bool,
    start_minutes: u64,
    end_minutes: u64,
) {
    state.notify_quiet_enabled.store(enabled, Ordering::Relaxed);
    state
        .notify_quiet_start_minutes
        .store(start_minutes.min(1439), Ordering::Relaxed);
    state
        .notify_quiet_end_minutes
        .store(end_minutes.min(1439), Ordering::Relaxed);
}

pub fn notifications_quiet_now(state: &AppState) -> bool {
    let now = Local::now();
    let local_minutes = u64::from(now.hour()) * 60 + u64::from(now.minute());
    is_quiet_minutes(
        state.notify_quiet_enabled.load(Ordering::Relaxed),
        state.notify_quiet_start_minutes.load(Ordering::Relaxed),
        state.notify_quiet_end_minutes.load(Ordering::Relaxed),
        local_minutes,
    )
}

fn is_quiet_minutes(enabled: bool, start: u64, end: u64, now: u64) -> bool {
    if !enabled || start == end {
        return false;
    }
    if start < end {
        now >= start && now < end
    } else {
        now >= start || now < end
    }
}

#[cfg(test)]
mod tests {
    use super::is_quiet_minutes;

    #[test]
    fn quiet_hours_support_same_day_and_overnight_windows() {
        assert!(is_quiet_minutes(true, 9 * 60, 17 * 60, 12 * 60));
        assert!(!is_quiet_minutes(true, 9 * 60, 17 * 60, 18 * 60));
        assert!(is_quiet_minutes(true, 18 * 60, 8 * 60, 23 * 60));
        assert!(is_quiet_minutes(true, 18 * 60, 8 * 60, 7 * 60));
        assert!(!is_quiet_minutes(true, 18 * 60, 8 * 60, 12 * 60));
        assert!(!is_quiet_minutes(false, 18 * 60, 8 * 60, 23 * 60));
    }
}

#[tauri::command]
pub async fn gh_list_notifications(
    state: State<'_, AppState>,
    all: Option<bool>,
) -> AppResult<Vec<Notification>> {
    let token = creds::require_token()?;
    github::list_notifications(&state, &token, all.unwrap_or(false)).await
}

#[tauri::command]
pub async fn gh_mark_notification_read(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let token = creds::require_token()?;
    github::mark_notification_read(&state, &token, &id).await
}
