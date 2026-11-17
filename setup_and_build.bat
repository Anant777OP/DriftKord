@echo off
setlocal EnableExtensions EnableDelayedExpansion
title DriftKord - one-click setup and build
cd /d "%~dp0"

rem =====================================================================================
rem  DriftKord - one-click installer/builder for Windows 11
rem    Double-click it. WASAPI Exclusive/Shared and ASIO (native host) are always included.
rem  Result: DriftKord.exe (portable) + installer copied to your Desktop.
rem =====================================================================================


echo.
echo  ==========================================================
echo     DRIFTKORD  -  setup ^& build
echo  ==========================================================
echo.

rem ---------- winget available? -------------------------------------------------------
where winget >nul 2>nul
if errorlevel 1 (
  echo [!] winget was not found. Install "App Installer" from the Microsoft Store, then run this again.
  goto :fail
)

rem ---------- 1. Microsoft C++ Build Tools -------------------------------------------
echo [1/6] Checking Microsoft C++ Build Tools...
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "HAVE_VC="
if exist "%VSWHERE%" (
  for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "HAVE_VC=%%i"
)
if not defined HAVE_VC (
  echo       Installing Visual Studio 2022 Build Tools with the C++ workload ^(several GB, 5-20 min^)...
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "HAVE_VC=%%i"
  )
  if not defined HAVE_VC (
    echo [!] C++ Build Tools did not install correctly. Install "Desktop development with C++" from
    echo     https://visualstudio.microsoft.com/visual-cpp-build-tools/ and run this script again.
    goto :fail
  )
)
echo       OK: !HAVE_VC!

rem ---------- 2. Rust ------------------------------------------------------------------
echo [2/6] Checking Rust...
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
where cargo >nul 2>nul
if errorlevel 1 (
  echo       Installing Rust ^(rustup^)...
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  where rustup >nul 2>nul || ( echo [!] Rust install failed. Get it from https://rustup.rs & goto :fail )
  rustup default stable-x86_64-pc-windows-msvc
)
rustup show active-toolchain >nul 2>nul || rustup default stable-x86_64-pc-windows-msvc
for /f "delims=" %%v in ('rustc --version') do echo       OK: %%v

rem ---------- 3. Node.js ---------------------------------------------------------------
echo [3/6] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo       Installing Node.js LTS...
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  where node >nul 2>nul || ( echo [!] Node.js install failed. Get it from https://nodejs.org & goto :fail )
)
for /f "delims=" %%v in ('node --version') do echo       OK: Node %%v

rem ---------- WebView2 (built into Windows 11, but check anyway) -----------------------
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" >nul 2>nul
if errorlevel 1 reg query "HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" >nul 2>nul
if errorlevel 1 (
  echo       Installing Microsoft Edge WebView2 Runtime...
  winget install --id Microsoft.EdgeWebView2Runtime -e --accept-source-agreements --accept-package-agreements
)

rem ---------- 4. JavaScript dependencies -----------------------------------------------
echo [4/6] Installing JavaScript dependencies...
if exist package-lock.json (
  call npm ci --no-audit --no-fund
) else (
  call npm install --no-audit --no-fund
)
if errorlevel 1 ( echo [!] npm install failed. & goto :fail )

rem ---------- 5. Build -----------------------------------------------------------------
echo [5/6] Compiling DriftKord ^(first build takes 5-15 minutes^)...
rem Short build path: avoids the 260-character Windows path limit inside deep folders.
set "CARGO_TARGET_DIR=%LOCALAPPDATA%\DriftKord-build"
if not exist "src-tauri\icons\icon.ico" call npx tauri icon app-icon.png
call npx tauri build --bundles nsis
set "BUILD_ERR=%errorlevel%"
set "EXE=%CARGO_TARGET_DIR%\release\DriftKord.exe"
if not exist "%EXE%" (
  echo [!] Build failed - scroll up for the first "error" line.
  goto :fail
)
if not "%BUILD_ERR%"=="0" echo [i] The installer step reported a problem, but the portable .exe was built.

rem ---------- 6. Copy to Desktop -------------------------------------------------------
echo [6/6] Copying to your Desktop...
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%d"
if not defined DESKTOP set "DESKTOP=%USERPROFILE%\Desktop"
tasklist /fi "imagename eq DriftKord.exe" | find /i "DriftKord.exe" >nul && (
  echo [!] DriftKord is running - close it so the Desktop copy can be replaced.
  echo     Press any key once it is closed...
  pause >nul
)
copy /y "%EXE%" "%DESKTOP%\DriftKord.exe" >nul
if errorlevel 1 ( echo [!] Could not overwrite %DESKTOP%\DriftKord.exe - is it still open? & goto :fail )
set "SETUP="
for %%f in ("%CARGO_TARGET_DIR%\release\bundle\nsis\*-setup.exe") do set "SETUP=%%~f"
if defined SETUP copy /y "!SETUP!" "%DESKTOP%\DriftKord-Setup.exe" >nul

echo.
echo  ==========================================================
echo   DONE!
echo     Portable app : %DESKTOP%\DriftKord.exe
if defined SETUP echo     Installer    : %DESKTOP%\DriftKord-Setup.exe
echo.
echo   First launch: Library ^> Add folder. For Explorer right-click
echo   menus and "Open with", use Settings ^> Windows integration.
echo  ==========================================================
echo.
pause
exit /b 0

:fail
echo.
echo  Setup did not finish. Fix the message above and double-click setup_and_build.bat again.
echo  (Everything already installed is kept, so the next run is faster.)
echo.
pause
exit /b 1
