@echo off
REM Refresh dividend / XR / XW / fundamentals from set.or.th and push to GitHub.
REM Must run on a PC in Thailand (set.or.th blocks cloud IPs). Safe to run any time;
REM GitHub Actions redeploys the page after the push. Log: logs\set_refresh.log
REM Override the interpreter with:  set PY=C:\path\to\python.exe
setlocal
cd /d "%~dp0.."
if not defined PY set "PY=D:\currentWork\programming\anaconda3\envs\stock\python.exe"
if not exist "%PY%" set "PY=python"
if not exist logs mkdir logs
call :main >> "logs\set_refresh.log" 2>&1
exit /b %ERRORLEVEL%

:main
echo ==== %DATE% %TIME% ====
git pull --rebase --autostash origin main
if errorlevel 1 (
  echo ABORT: git pull failed
  exit /b 1
)
"%PY%" scripts\fetch_set_info.py
if errorlevel 1 (
  echo ABORT: fetch_set_info.py failed
  exit /b 1
)
git add data/set_info.json data/set_info
git diff --cached --quiet
if not errorlevel 1 (
  echo No changes.
  exit /b 0
)
git commit -m "data: SET dividends/corporate actions %DATE%"
if errorlevel 1 exit /b 1
git push origin main
if errorlevel 1 (
  REM the Actions bot may have pushed prices meanwhile - rebase once and retry
  git pull --rebase origin main
  git push origin main
  if errorlevel 1 (
    echo ABORT: git push failed
    exit /b 1
  )
)
echo OK pushed.
exit /b 0
