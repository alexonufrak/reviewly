mod auth;
mod clients;
mod commands;
mod creds;
mod error;
mod migrations;
mod state;
mod tray;
mod workers;

use state::AppState;
use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "reviewly_lib=info,warn".into()),
        )
        .with_target(false)
        .init();

    let migrations = migrations::migrations();

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:reviewly.db", migrations)
                .build(),
        )
        .on_window_event(|window, event| {
            // Close-to-tray: the red traffic light / ⌘W hides the window instead
            // of quitting. The app keeps running in the menu-bar tray; only
            // "Quit Reviewly" (tray menu) or ⌘Q actually exits.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        // Custom app menu so "About Reviewly" opens our branded panel instead of
        // the generic native one. Standard Edit/Window items are kept so
        // copy/paste/undo and minimize still work.
        .menu(|handle| {
            let about = MenuItem::with_id(handle, "about", "About Reviewly", true, None::<&str>)?;
            let app_menu = SubmenuBuilder::new(handle, "Reviewly")
                .item(&about)
                .separator()
                .item(&PredefinedMenuItem::hide(handle, None)?)
                .item(&PredefinedMenuItem::hide_others(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(handle, None)?)
                .build()?;
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .item(&PredefinedMenuItem::undo(handle, None)?)
                .item(&PredefinedMenuItem::redo(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(handle, None)?)
                .item(&PredefinedMenuItem::copy(handle, None)?)
                .item(&PredefinedMenuItem::paste(handle, None)?)
                .item(&PredefinedMenuItem::select_all(handle, None)?)
                .build()?;
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .item(&PredefinedMenuItem::minimize(handle, None)?)
                .item(&PredefinedMenuItem::close_window(handle, None)?)
                .build()?;
            MenuBuilder::new(handle)
                .item(&app_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "about" {
                let _ = app.emit("menu:about", ());
            }
        })
        .setup(|app| {
            app.manage(AppState::new());

            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{
                    apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                };
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::HudWindow,
                        Some(NSVisualEffectState::FollowsWindowActiveState),
                        None,
                    ) {
                        tracing::warn!("apply_vibrancy failed: {e:?}");
                    } else {
                        tracing::info!("vibrancy applied (HudWindow material)");
                    }
                }
            }

            #[cfg(target_os = "windows")]
            {
                use window_vibrancy::apply_mica;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = apply_mica(&window, Some(true));
                }
            }

            if let Err(e) = tray::build(app.handle()) {
                tracing::warn!("tray build failed: {e}");
            }

            // Start hidden in the tray when the user opted in (read from a flag
            // file written by `set_start_in_tray`, before the frontend loads).
            if commands::app::should_start_in_tray(app.handle()) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                workers::start_all(handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // auth
            commands::auth::auth_status,
            commands::auth::auth_device_start,
            commands::auth::auth_device_poll,
            commands::auth::auth_sign_out,
            commands::auth::auth_gh_available,
            commands::auth::auth_use_gh_cli,
            // search
            commands::search::gh_review_requested,
            commands::search::gh_created,
            commands::search::gh_involves,
            commands::search::gh_search,
            commands::search::gh_search_count,
            commands::search::gh_pr_ci,
            commands::search::gh_dashboard,
            commands::search::gh_list_repo_pulls,
            commands::search::gh_list_repos_open_prs,
            commands::search::gh_list_repo_pulls_delta,
            commands::search::set_watched_repos,
            // pulls
            commands::pulls::gh_get_pull,
            commands::pulls::gh_list_pull_files,
            commands::pulls::gh_list_commits,
            commands::pulls::gh_list_checks,
            commands::pulls::gh_check_annotations,
            commands::pulls::gh_actions_job,
            commands::pulls::gh_rerun_job,
            commands::pulls::gh_rerun_failed_jobs,
            commands::pulls::gh_required_contexts,
            commands::pulls::gh_rerun_check,
            commands::pulls::gh_get_file_content,
            // local git workspace
            commands::git::git_repo_info,
            commands::git::git_clone,
            commands::git::list_dir,
            commands::git::read_file,
            commands::git::read_file_data_url,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_worktrees,
            commands::git::gh_pr_create,
            commands::git::gh_dependabot_ai_fix_bg,
            commands::git::dependabot_inflight,
            commands::git::gh_list_branches,
            commands::git::gh_resolve_conflicts_ai,
            commands::git::gh_pr_checkout,
            commands::git::git_status,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_discard,
            commands::git::git_diff_file,
            commands::git::git_staged_diff,
            commands::git::git_commit,
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
            commands::git::git_show,
            commands::git::git_log,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_ls_files,
            commands::git::git_grep,
            commands::git::git_file_activity,
            commands::git::git_branch_changes,
            commands::git::local_editor_targets,
            commands::git::open_local_editor,
            // reviews
            commands::reviews::gh_list_reviews,
            commands::reviews::gh_submit_review,
            // comments
            commands::comments::gh_list_review_comments,
            commands::comments::gh_list_issue_comments,
            commands::comments::gh_create_issue_comment,
            commands::comments::gh_reply_review_comment,
            commands::comments::gh_create_review_comment,
            // notifications
            commands::notifications::set_notifications_enabled,
            commands::notifications::set_notification_reasons,
            commands::notifications::set_poll_interval,
            commands::notifications::set_notification_quiet_hours,
            commands::notifications::gh_list_notifications,
            commands::notifications::gh_mark_notification_read,
            commands::actions::gh_mark_all_notifications_read,
            // app behavior
            commands::app::set_launch_at_login,
            commands::app::get_launch_at_login,
            commands::app::set_start_in_tray,
            commands::app::set_app_icon,
            // attachments
            commands::attachments::gh_fetch_attachment,
            // actions (mutations: reactions, labels, reviewers, merge, etc.)
            commands::actions::gh_list_reactions,
            commands::actions::gh_react,
            commands::actions::gh_unreact,
            commands::actions::gh_repo_labels,
            commands::actions::gh_set_pr_labels,
            commands::actions::gh_remove_pr_label,
            commands::actions::gh_request_reviewers,
            commands::actions::gh_remove_reviewers,
            commands::actions::gh_get_requested_reviewers,
            commands::actions::gh_repo_collaborators,
            commands::actions::gh_set_pr_state,
            commands::actions::gh_update_pr,
            commands::actions::gh_merge_pr,
            commands::actions::gh_enable_auto_merge,
            commands::actions::gh_disable_auto_merge,
            commands::actions::gh_dependabot_alerts,
            commands::actions::gh_list_repos,
            commands::actions::gh_user,
            commands::actions::gh_update_branch,
            commands::actions::gh_set_draft,
            commands::actions::gh_resolve_thread,
            commands::actions::gh_edit_issue_comment,
            commands::actions::gh_delete_issue_comment,
            commands::actions::gh_edit_review_comment,
            commands::actions::gh_delete_review_comment,
            commands::actions::gh_pr_node_id,
            commands::actions::gh_list_review_threads,
            commands::actions::gh_activity,
            // ai
            commands::ai::ai_available,
            commands::ai::ai_review,
            commands::ai::ai_review_bg,
            commands::ai::ai_stream,
            commands::ai::ai_inflight,
            commands::ai::ai_cancel,
            commands::ai::path_is_dir,
            // tray
            tray::tray_set_title,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
