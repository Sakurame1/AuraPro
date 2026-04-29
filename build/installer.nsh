!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Clearing user data..."
    RMDir /r "$APPDATA\AuraPro"
    RMDir /r "$LOCALAPPDATA\AuraPro"
    RMDir /r "$APPDATA\com.aurapro.desktop"
    RMDir /r "$LOCALAPPDATA\com.aurapro.desktop"
  ${endif}
!macroend
