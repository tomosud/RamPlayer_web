@echo off
REM Build and run the standalone scene detection review test.
REM Run npm install in the repository root beforehand.

cd /d "%~dp0.."

echo [scene-test] Building latest test page...
call npm run build
if errorlevel 1 (
  echo [scene-test] Build failed.
  pause
  exit /b 1
)

set PORT=8124
echo [scene-test] Opening http://localhost:%PORT%/cut-test.html
echo [scene-test] Press Ctrl+C to stop.

start "" /min cmd /c "ping 127.0.0.1 -n 3 >nul & start http://localhost:%PORT%/cut-test.html"

python -m http.server %PORT% --directory dist
