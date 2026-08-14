; Installs/removes the Windows Service alongside the desktop app, so the
; monitoring keeps running at boot whether or not the GUI is ever opened.
;
; Two things this file depends on, both easy to get wrong:
;   - Tauri preserves the relative path of bundled resources, so the service
;     binary lands in $INSTDIR\bin\, not $INSTDIR\.
;   - Registering a service needs elevation, which comes from the
;     "installMode": "perMachine" setting in tauri.conf.json. Without it NSIS
;     installs per-user with no UAC prompt and registration fails.
; Failures are reported rather than swallowed — a silently unregistered service
; looks exactly like a broken app, because every API call then fails.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering the Controll Server Monitor service..."
  ExecWait '"$INSTDIR\bin\controll-server-monitor-service.exe" install' $0
  StrCmp $0 "0" csm_install_ok csm_install_failed
  csm_install_failed:
    MessageBox MB_ICONEXCLAMATION "Could not register the Controll Server Monitor Windows Service (exit code $0).$\r$\n$\r$\nThe app will still be installed, but background monitoring will not run and the dashboard will not be able to load any data."
    Goto csm_install_done
  csm_install_ok:
    DetailPrint "Starting the Controll Server Monitor service..."
    ExecWait 'sc.exe start ControllServerMonitor'
  csm_install_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping and removing the Controll Server Monitor service..."
  ExecWait 'sc.exe stop ControllServerMonitor'
  ExecWait '"$INSTDIR\bin\controll-server-monitor-service.exe" uninstall'
!macroend
