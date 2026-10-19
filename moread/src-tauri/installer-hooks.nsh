; MoRead installer hooks (included by Tauri's generated installer.nsi)
;
; Why this file exists - two extra clicks the stock Tauri installer asks for.
;
; 1) Finish page jump.
;    Tauri's NSIS template defines MUI_FINISHPAGE_NOAUTOCLOSE on purpose, so the
;    install page stays on "completed" until the user clicks Next. MUI2 implements
;    that switch by skipping `SetAutoClose true` in the finish page's GUIInit.
;    For a small reader installer there is nothing to debug on that page, and the
;    extra click reads as if the install did not finish on its own.
;    Setting the auto close mode restores the jump.
;
; 2) "MoRead is running - click OK to terminate it".
;    The template calls CheckIfAppIsRunning right after NSIS_HOOK_PREINSTALL.
;    It asks with a modal MessageBox (silent mode kills without asking). Killing
;    the instance first means the RestartManager check finds nothing and the box
;    never appears. MoRead keeps no unsaved state - every setting is written to
;    localStorage as it changes, and documents are read-only - so a force quit
;    loses nothing but the scroll position. The action is logged in the details
;    pane instead of prompting.
;
; Keep this file pure ASCII: NSIS may read included files with the system ANSI
; code page, and comments are not worth an encoding gamble.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /IM ${MAINBINARYNAME}.exe /F'
  Pop $0
  ${If} $0 == 0
    DetailPrint "Closed a running ${PRODUCTNAME} instance."
    Sleep 600
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetAutoClose true
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /IM ${MAINBINARYNAME}.exe /F'
  Pop $0
  ${If} $0 == 0
    DetailPrint "Closed a running ${PRODUCTNAME} instance."
    Sleep 600
  ${EndIf}
!macroend
