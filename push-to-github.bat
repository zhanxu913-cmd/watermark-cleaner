@echo off
title 推送代码到 GitHub
cd /d "C:/Users/Administrator/WorkBuddy/2026-09-24-14-51-00/watermark-cleaner"

echo.
echo ==================================================
echo    正在把代码推送到 GitHub
echo ==================================================
echo.
echo   目标仓库: https://github.com/zhanxu913-cmd/watermark-cleaner
echo.
echo   稍后会弹出 GitHub 登录窗口, 请按提示操作:
echo     1) 点击 "Sign in with your browser"
echo     2) 在浏览器里点击绿色的 Authorize 授权按钮
echo     3) 回到本窗口, 等待上传完成 (约几秒钟)
echo.
echo ==================================================
echo.
pause

git push -f -u origin main

echo.
if %errorlevel%==0 (
  echo   [成功] 代码已推送完成
  echo   打开查看: https://github.com/zhanxu913-cmd/watermark-cleaner
) else (
  echo   [失败] 请把上面的错误信息截图发给我
)
echo.
pause
