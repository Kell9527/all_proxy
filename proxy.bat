@echo off
setlocal enabledelayedexpansion

rem ============================================================
rem  all_proxy 服务管理（菜单式，Windows 原生）
rem
rem  用法一：双击运行，按菜单数字选择
rem  用法二：命令行带参数直接执行（不进菜单）
rem          proxy.bat [start|stop|status|restart|logs]
rem
rem  端口/地址沿用服务本身的环境变量：
rem          ALL_PROXY_PORT（默认 3877）、ALL_PROXY_HOST（默认 127.0.0.1）
rem
rem  说明：
rem  - PID / 日志文件在 data\run\ 下，与 proxy.sh 共用同一份 PID 记录；
rem    两者混用时 PID 语义可能不一致（msys pid vs Windows pid），
rem    停止动作一律带「按端口兜底清理」，保证能停干净。
rem  - taskkill /F 为强制结束（控制台进程对普通关闭消息不响应）；
rem    服务数据为 SQLite + JSON 文件，单进程写入下强杀无损坏风险。
rem  - 本文件须以 GBK 编码 + CRLF 行尾保存（cmd 原生兼容）；
rem    UTF-8 源在 scripts/proxy.bat.src，改后执行：
rem      sed 's/$/\r/' scripts/proxy.bat.src | iconv -f UTF-8 -t GBK > proxy.bat
rem ============================================================

cd /d "%~dp0"

set "PORT=%ALL_PROXY_PORT%"
if "%PORT%"=="" set "PORT=3877"
set "HOST=%ALL_PROXY_HOST%"
if "%HOST%"=="" set "HOST=127.0.0.1"

set "RUN_DIR=data\run"
set "PID_FILE=%RUN_DIR%\all-proxy.pid"
set "OUT_LOG=%RUN_DIR%\all-proxy.out.log"
set "ERR_LOG=%RUN_DIR%\all-proxy.err.log"
set "HEALTH_URL=http://%HOST%:%PORT%/health"

if not exist "%RUN_DIR%" mkdir "%RUN_DIR%"

rem 带参数：直接执行对应动作（不进菜单、不暂停），便于脚本化调用
if not "%~1"=="" (
    set "ACTION=%~1"
    call :run_action
    exit /b %ERRORLEVEL%
)

:menu
cls
echo ==============================================
echo    all_proxy 服务管理        %HOST%:%PORT%
echo ==============================================
call :show_status
echo ----------------------------------------------
echo    [1] 启动（后台）
echo    [2] 停止
echo    [3] 刷新状态
echo    [4] 重启
echo    [5] 查看日志（Ctrl+C 退出跟踪）
echo    [0] 退出
echo ----------------------------------------------
choice /C 123450 /N /M "请选择: "
if errorlevel 6 goto :eof
if errorlevel 5 set "ACTION=logs"   & call :run_action & goto menu
if errorlevel 4 set "ACTION=restart" & call :run_action & goto menu
if errorlevel 3 set "ACTION=status" & call :run_action & goto menu
if errorlevel 2 set "ACTION=stop"   & call :run_action & goto menu
if errorlevel 1 set "ACTION=start"  & call :run_action & goto menu
goto :eof

rem == 动作分发 ===============================================
:run_action
if /i "%ACTION%"=="start"   goto :do_start
if /i "%ACTION%"=="stop"    goto :do_stop
if /i "%ACTION%"=="status"  goto :do_status
if /i "%ACTION%"=="restart" goto :do_restart
if /i "%ACTION%"=="logs"    goto :do_logs
echo 未知动作: %ACTION%
exit /b 1

rem == 工具：当前 %PID% 的进程是否存活（结果在 PID_ALIVE） =====
rem 用 PowerShell 而不是 tasklist /FI：实测本调用环境下
rem tasklist 的 /FI 引号参数会被拆坏（报「无效参数 - 'eq'」）。
:proc_alive
set "PID_ALIVE=0"
if not defined PID goto :eof
powershell -NoProfile -Command "if (Get-Process -Id %PID% -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 set "PID_ALIVE=1"
goto :eof

rem == 工具：PID 文件里的进程是否存活 =========================
:pid_alive
set "PID="
rem 用 for /f 读取（会剥掉行尾 CRLF；set /p 只剥 LF，会留下 CR）
if exist "%PID_FILE%" for /f %%a in ('type "%PID_FILE%" 2^>nul') do set "PID=%%a"
call :proc_alive
goto :eof

rem == 状态一行摘要（菜单头部与 status 动作共用） ==============
:show_status
call :pid_alive
if "%PID_ALIVE%"=="1" (
    echo    当前: 进程运行中, pid %PID%
) else if defined PID (
    echo    当前: PID 记录已失效（pid %PID%）
) else (
    echo    当前: 无 PID 记录
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING 2^>nul') do (
    echo    端口 %PORT% 被占用（Windows pid: %%p^）
)
goto :eof

rem == 启动 ===================================================
:do_start
call :pid_alive
if "%PID_ALIVE%"=="1" (
    echo 已在运行（pid %PID%，端口 %PORT%）。如需重启请先选「停止」。
    goto :do_start_done
)
rem PID 记录失效但端口仍被占：不重复启动，避免起双实例
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING 2^>nul') do (
    echo 端口 %PORT% 已被 Windows 进程 %%p 占用，未启动。可先执行「停止」清理。
    goto :do_start_done
)
del "%PID_FILE%" 2>nul

if not exist node_modules (
    echo 缺少依赖，先安装（npm install）……
    call npm install || ( echo 安装失败，中止启动 & exit /b 1 )
)
if not exist dist\index.js (
    echo 未找到 dist\index.js，先构建……
    call npm run build && call npm run build:assets || ( echo 构建失败，中止启动 & exit /b 1 )
)
if not exist dist\providers\qoder-auth-wasm.wasm (
    echo 缺少 Qoder WASM 资产，补复制……
    call npm run build:assets || ( echo 资产复制失败，中止启动 & exit /b 1 )
)
if not exist web\dist\index.html (
    echo 提示: web\dist 不存在，管理端页面未构建（API 不受影响）。需要时执行: npm run build:web
)

echo 后台启动 all_proxy（%HOST%:%PORT%）……
rem PowerShell 直接把 Windows PID 写入 PID 文件。
rem 注意不能放在 for /f 里捕获输出：命令含单引号，会与 for /f 的
rem 单引号定界符冲突导致捕获失败（实测 PID 文件为空）。
rem -NoNewline 必须带：默认写入带 CRLF，set /p 读回会把 CR 留在
rem 变量里，tasklist 按 "PID eq 29040<CR>" 过滤恒不命中（实测）。
powershell -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory '%CD%' -RedirectStandardOutput '%CD%\%OUT_LOG%' -RedirectStandardError '%CD%\%ERR_LOG%' -WindowStyle Hidden -PassThru; Set-Content -Path '%CD%\%PID_FILE%' -Value $p.Id -NoNewline -ErrorAction Stop"
set "PID="
if exist "%PID_FILE%" for /f %%a in ('type "%PID_FILE%" 2^>nul') do set "PID=%%a"
if not defined PID (
    echo 启动失败：未能创建进程或未取得 PID，请检查 node 是否可用。
    type "%ERR_LOG%" 2>nul
    exit /b 1
)

rem 探活等待：/health 返回 200 即就绪，最多 15 秒。
rem 延迟用 ping（timeout 命令在 stdin 重定向的调用环境会直接报错）。
set /a TRIES=0
:wait_loop
curl -s -o nul --max-time 2 -w "%%{http_code}" "%HEALTH_URL%" > "%TEMP%\all_proxy_code.txt" 2>nul
set /p CODE=<"%TEMP%\all_proxy_code.txt"
if "%CODE%"=="200" (
    echo 已就绪（pid %PID%）: http://%HOST%:%PORT%
    echo   健康检查: %HEALTH_URL%    日志: %OUT_LOG%
    goto :do_start_done
)
call :proc_alive
if "%PID_ALIVE%"=="0" (
    echo 启动失败（进程已退出），日志尾部：
    powershell -NoProfile -Command "Get-Content '%OUT_LOG%','%ERR_LOG%' -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue"
    del "%PID_FILE%" 2>nul
    exit /b 1
)
ping -n 2 127.0.0.1 >nul
set /a TRIES+=1
if %TRIES% lss 15 goto :wait_loop
echo 进程在运行（pid %PID%）但 15 秒内未就绪，请查看日志: %OUT_LOG%
exit /b 1

:do_start_done
exit /b 0

rem == 停止 ===================================================
:do_stop
call :pid_alive
if "%PID_ALIVE%"=="1" (
    echo 停止 pid %PID% ……
    taskkill /T /F /PID %PID% >nul 2>&1
    ping -n 2 127.0.0.1 >nul
) else (
    if defined PID (echo PID 记录已失效（pid %PID%）) else (echo 无运行中的记录)
)
del "%PID_FILE%" 2>nul

rem 兜底：端口仍被占（如上次异常退出留下的进程，或 proxy.sh 启动的实例）
set "FOUND=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING 2^>nul') do (
    set "FOUND=1"
    echo 端口 %PORT% 仍被 Windows 进程 %%p 占用，强制结束……
    taskkill /T /F /PID %%p >nul 2>&1
)
if "%FOUND%"=="0" echo 已停止
exit /b 0

rem == 状态 ===================================================
:do_status
call :show_status
if "%PID_ALIVE%"=="1" (
    curl -s -o nul --max-time 2 -w "%%{http_code}" "%HEALTH_URL%" > "%TEMP%\all_proxy_code.txt" 2>nul
    set /p CODE=<"%TEMP%\all_proxy_code.txt"
    if "!CODE!"=="200" (
        echo    健康检查: /health 200 —— 服务正常
    ) else (
        echo    健康检查: /health 无响应（code !CODE!）—— 可能正在启动
    )
)
if exist "%OUT_LOG%" echo    日志: %OUT_LOG%
exit /b 0

rem == 重启 ===================================================
:do_restart
call :do_stop
echo.
call :do_start
exit /b %ERRORLEVEL%

rem == 日志跟踪 ===============================================
:do_logs
if not exist "%OUT_LOG%" (
    echo 暂无日志: %OUT_LOG%
    exit /b 0
)
rem Ctrl+C 退出跟踪
powershell -NoProfile -Command "Get-Content '%OUT_LOG%' -Tail 100 -Wait -Encoding UTF8"
exit /b 0
