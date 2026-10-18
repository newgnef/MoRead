@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem NOTE: this file is intentionally 100% ASCII, comments included.
rem cmd.exe parses a .bat line by line using the system ANSI codepage
rem (GBK on a Simplified-Chinese Windows), while the file itself is UTF-8.
rem Non-ASCII text gets mis-decoded before chcp takes effect, and the resulting
rem garbage can contain characters like & | > that break the script syntax.
rem Learned the hard way: a Chinese comment made the script die at startup.

echo.
echo   MoRead - read-only Markdown reader
echo   ----------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Node.js not found.
  echo       Please install an LTS build first: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   [1/3] Installing dependencies, first run takes about a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto fail
) else (
  echo   [1/3] Dependencies ready
)

echo   [2/3] Building frontend...
rem wipe dist first so a stale bundle can never be served
if exist "dist" rmdir /s /q "dist"
call npm run build
if errorlevel 1 goto fail

echo   [3/3] Starting local server
echo.
echo         URL:   http://localhost:1421
echo         Stop:  close this window
echo.
call npm run preview -- --open

goto done

:fail
echo.
echo   [!] Something failed. Send the text above and I will take a look.
echo.
pause
exit /b 1

:done
endlocal
