use std::env;
use std::ffi::OsString;
use std::sync::mpsc;
use std::time::Duration;

use windows_service::{
    define_windows_service,
    service::{
        ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode,
        ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
    service_manager::{ServiceManager, ServiceManagerAccess},
};

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
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CREATE_SERVICE)?;

    let exe_path = env::current_exe().expect("failed to resolve own exe path");

    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe_path,
        launch_arguments: vec![OsString::from("run")],
        dependencies: vec![],
        account_name: None, // LocalSystem — needs to run independent of any logged-in user
        account_password: None,
    };

    let service = manager.create_service(&service_info, ServiceAccess::CHANGE_CONFIG)?;
    service.set_description(SERVICE_DESCRIPTION)?;

    println!("Service '{SERVICE_DISPLAY_NAME}' installed. Start it with: sc start {SERVICE_NAME}");
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
