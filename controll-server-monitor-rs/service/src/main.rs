use std::env;
use std::ffi::{OsStr, OsString};
use std::sync::mpsc;
use std::time::Duration;

use windows_service::{
    define_windows_service,
    service::{
        ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
        ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
        ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
    service_manager::{ServiceManager, ServiceManagerAccess},
};

// ERROR_SERVICE_DOES_NOT_EXIST — returned by OpenServiceW when the service is not
// yet registered (the normal case on a first install).
const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
// ERROR_SERVICE_ALREADY_RUNNING — returned by StartServiceW when the service is
// already up (e.g. re-running `install` over a working install).
const ERROR_SERVICE_ALREADY_RUNNING: i32 = 1056;

const SERVICE_NAME: &str = "ControllServerMonitor";
const SERVICE_DISPLAY_NAME: &str = "Controll Server Monitor";
const SERVICE_DESCRIPTION: &str =
    "Monitors registered sites' stats and keeps them alive in the background, independent of any logged-in user.";

fn main() {
    let args: Vec<String> = env::args().collect();
    let result = match args.get(1).map(|s| s.as_str()) {
        Some("install") => install_service(),
        Some("uninstall") => uninstall_service(),
        Some("run") | None => {
            // The SCM launches services with no meaningful way to pass extra args
            // interactively, so `run` (or no args at all) is both the SCM's real
            // entry point and the one used for interactive testing from a console.
            // service_dispatcher::start only succeeds when actually launched by the
            // SCM; outside of that it returns an error immediately, so falling back
            // to running the server directly lets `cargo run` / manual testing work
            // without needing the service to be installed first.
            if service_dispatcher::start(SERVICE_NAME, ffi_service_main).is_err() {
                run_server_blocking();
            }
            Ok(())
        }
        Some(other) => {
            eprintln!("Unknown argument: {other}. Use install | uninstall | run.");
            Ok(())
        }
    };

    if let Err(err) = result {
        eprintln!("error: {err}");
        eprintln!("(installing or removing a Windows Service requires an elevated Administrator prompt)");
        std::process::exit(1);
    }
}

define_windows_service!(ffi_service_main, service_main);

fn service_main(_arguments: Vec<OsString>) {
    if let Err(err) = run_service() {
        eprintln!("service error: {err}");
    }
}

fn run_service() -> windows_service::Result<()> {
    let (shutdown_tx, shutdown_rx) = mpsc::channel();

    let event_handler = move |control_event| -> ServiceControlHandlerResult {
        match control_event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = shutdown_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };

    let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;

    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    })?;

    // The Tokio runtime and axum server run on a plain OS thread so the SCM
    // control-event loop above stays free to react to Stop/Shutdown even while
    // the server is busy. The process is torn down right after shutdown_rx
    // resolves, so there is no need to join the server thread cleanly.
    std::thread::spawn(|| {
        let rt = tokio::runtime::Runtime::new().expect("failed to build tokio runtime");
        rt.block_on(serve());
    });

    let _ = shutdown_rx.recv();

    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    })?;

    Ok(())
}

fn run_server_blocking() {
    let rt = tokio::runtime::Runtime::new().expect("failed to build tokio runtime");
    rt.block_on(serve());
}

async fn serve() {
    let (state, log_path) = common::init_state();
    let data_dir = common::data_dir();
    let app = common::build_router(state);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], common::DEFAULT_PORT));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {addr}: {err}"));

    println!("Controll Server Monitor service listening at http://{addr}/");
    println!("Data directory: {}", data_dir.display());
    println!("Keep-alive log: {}", log_path.display());

    axum::serve(listener, app).await.expect("server error");
}

fn install_service() -> windows_service::Result<()> {
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )?;

    let exe_path = env::current_exe().expect("failed to resolve own exe path");

    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        // AutoStart => SERVICE_AUTO_START: the SCM starts it during system boot,
        // before any user logs in. This is the setting that makes monitoring
        // survive a reboot.
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe_path,
        launch_arguments: vec![OsString::from("run")],
        dependencies: vec![],
        account_name: None, // LocalSystem — needs to run independent of any logged-in user
        account_password: None,
    };

    // Make install idempotent. On an upgrade the service already exists, and
    // `create_service` would fail with ERROR_SERVICE_EXISTS — which the NSIS
    // installer then surfaces as a scary "could not register" dialog even though
    // monitoring is fine. Worse, an older install could have been registered
    // with a non-boot start type that a plain re-create would never correct.
    // So: reconfigure it in place if present, create it otherwise.
    let access = ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS;
    let service = match manager.open_service(SERVICE_NAME, access) {
        Ok(existing) => {
            existing.change_config(&service_info)?;
            println!("Service '{SERVICE_DISPLAY_NAME}' already registered — configuration refreshed.");
            existing
        }
        Err(windows_service::Error::Winapi(e))
            if e.raw_os_error() == Some(ERROR_SERVICE_DOES_NOT_EXIST) =>
        {
            let created = manager.create_service(&service_info, access)?;
            println!("Service '{SERVICE_DISPLAY_NAME}' installed.");
            created
        }
        Err(other) => return Err(other),
    };

    service.set_description(SERVICE_DESCRIPTION)?;

    // Explicitly clear any "delayed" flag a previous install might have set, so
    // the service comes up during boot rather than a couple of minutes after.
    service.set_delayed_auto_start(false)?;

    // If the service ever exits unexpectedly — including a failed start at boot
    // (network stack not ready, disk still spinning up) — have the SCM bring it
    // back on its own rather than leaving the fleet unmonitored until someone
    // notices. Retry after 5s, then 15s, then every 60s; forget the failure
    // count after a clean day.
    service.update_failure_actions(ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(60 * 60 * 24)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![
            ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(5),
            },
            ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(15),
            },
            ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(60),
            },
        ]),
    })?;
    // Treat a non-zero exit / failed start as a failure too, not just a crash.
    service.set_failure_actions_on_non_crash_failures(true)?;

    // Start it now so the install is self-sufficient (the NSIS installer also
    // issues `sc start`, which is then a harmless no-op).
    let no_args: [&OsStr; 0] = [];
    match service.start(&no_args) {
        Ok(()) => println!("Service '{SERVICE_DISPLAY_NAME}' started."),
        Err(windows_service::Error::Winapi(e))
            if e.raw_os_error() == Some(ERROR_SERVICE_ALREADY_RUNNING) =>
        {
            println!("Service '{SERVICE_DISPLAY_NAME}' is already running.");
        }
        Err(e) => {
            println!(
                "Service '{SERVICE_DISPLAY_NAME}' is installed and set to start automatically at boot, \
                 but could not be started right now ({e}). Run: sc start {SERVICE_NAME}"
            );
        }
    }

    Ok(())
}

fn uninstall_service() -> windows_service::Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service = manager.open_service(SERVICE_NAME, ServiceAccess::DELETE | ServiceAccess::STOP)?;

    let _ = service.stop();
    service.delete()?;

    println!("Service '{SERVICE_DISPLAY_NAME}' uninstalled.");
    Ok(())
}
