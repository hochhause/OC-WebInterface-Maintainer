@echo off
setlocal enabledelayedexpansion

if exist server\.env goto install

echo.
echo  OC Level Maintainer
echo  --------------------
echo.
echo  Local setup: no website password needed on this machine.
echo  Your Connector computer's key decides which network you see;
echo  run install-connector in game and it generates one for you.
echo.
set /p PORT=  Port [3000]:
if "!PORT!"=="" set PORT=3000

(
  echo PORT=!PORT!
  echo DATA_DIR=data
  echo SINGLE_USER=true
) > server\.env

echo.
echo  Saved to server\.env
echo.

:install
if not exist server\node_modules (
  echo  Installing server dependencies...
  pushd server
  npm install
  popd
  echo.
)
if not exist client\node_modules (
  echo  Installing client dependencies...
  pushd client
  npm install
  popd
  echo.
)

echo  Building client...
pushd client
call npm run build
popd

echo.
echo  Starting server...
echo  Database: server\data\data.db
echo.
pushd server
node index.js
popd

pause
