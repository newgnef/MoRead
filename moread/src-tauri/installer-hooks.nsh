; MoRead installer hooks (included by Tauri's generated installer.nsi)
;
; Why this file exists:
; Tauri's NSIS template defines MUI_FINISHPAGE_NOAUTOCLOSE on purpose, so the
; install page stays on "completed" until the user clicks Next. MUI2 implements
; that switch by skipping `SetAutoClose true` in the finish page's GUIInit.
; For a small reader installer there is nothing to debug on that page, and the
; extra click reads as if the install did not finish on its own.
;
; Setting the auto close mode ourselves restores the jump: once every section
; has run, the install page closes and the finish page appears by itself.
; Keep this file pure ASCII - NSIS may read included files with the system ANSI
; code page, and comments are not worth an encoding gamble.

!macro NSIS_HOOK_POSTINSTALL
  SetAutoClose true
!macroend
