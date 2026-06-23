@echo off
REM Local check: build dist, serve with Python's simple server, open the browser.
REM Run `npm install` beforehand.
REM (ASCII only on purpose: .bat is read with the OEM codepage, so non-ASCII breaks it.)

cd /d "%~dp0"

if not exist "dist\index.html" (
  echo [run] dist not found, building...
  call npm run build
  if errorlevel 1 (
    echo [run] Build failed.
    pause
    exit /b 1
  )
)

set PORT=8123
echo [run] Serving on http://localhost:%PORT%/  (Ctrl+C to stop)

REM Open the browser in a separate process after a short wait,
REM so we don't hit the server before it is up.
start "" /min cmd /c "ping 127.0.0.1 -n 3 >nul & start http://localhost:%PORT%/"

python -m http.server %PORT% --directory dist
