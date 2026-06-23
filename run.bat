@echo off
REM ローカル確認用：dist をビルドして Python の簡易サーバーで配信し、ブラウザを開く。
REM 事前に `npm install` を済ませておくこと。

cd /d "%~dp0"

if not exist "dist\index.html" (
  echo [run] dist が無いのでビルドします...
  call npm run build
  if errorlevel 1 (
    echo [run] ビルドに失敗しました。
    pause
    exit /b 1
  )
)

set PORT=8000
echo [run] http://localhost:%PORT%/ で配信します。 Ctrl+C で停止。
start "" "http://localhost:%PORT%/"
python -m http.server %PORT% --directory dist
