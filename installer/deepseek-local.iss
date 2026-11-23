; DeepSeek Local —— 安装包脚本（Inno Setup 6）
; 用法：ISCC.exe installer\deepseek-local.iss
; 产物：dist\installer\DeepSeekLocal-Setup-1.0.2.exe

#define MyAppName "DeepSeek Local"
#define MyAppVersion "1.0.2"
#define MyAppPublisher "local"
#define MyLauncher "DeepSeekLauncher.exe"

[Setup]
AppId={{8B3C5E1A-4F27-4F3C-9B4D-6E2A71C5D902}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\DeepSeekLocal
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; 按用户安装，不需要管理员
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist\installer
OutputBaseFilename=DeepSeekLocal-Setup-{#MyAppVersion}
SetupIconFile=..\assets\app.ico
; 出错时自动写日志到 %TEMP%\Setup Log*.txt（便于排障）
SetupLogging=yes
UninstallDisplayIcon={app}\{#MyLauncher}
UninstallDisplayName={#MyAppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=110
DisableWelcomePage=no
AllowNoIcons=yes
; 运行中的旧版本交给 [UninstallRun]/[Run] 处理，这里只要求关闭
CloseApplications=yes
CloseApplicationsFilter=DeepSeek.exe,{#MyLauncher}
RestartApplications=no

[Languages]
Name: "chinese"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: checkedonce

[Files]
; 应用本体（跳过 data 目录：那是开发工作区的数据 junction，用户数据在 %LOCALAPPDATA%\DeepSeekLocal\data）
Source: "..\dist\DeepSeek-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "data,data\*"
; 说明文件（如有）
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyLauncher}"; WorkingDir: "{app}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyLauncher}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; 装完直接启动（静默安装不启动）
Filename: "{app}\{#MyLauncher}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载前关掉应用与启动器
Filename: "{sys}\taskkill.exe"; Parameters: "/IM DeepSeek.exe /T /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "killapp"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#MyLauncher} /T /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "killauncher"

[UninstallDelete]
; 干净卸载：清掉安装目录残留（用户数据目录 {localappdata}\DeepSeekLocal\data 故意不删）
Type: filesandordirs; Name: "{app}\*"

[Code]
// 安装前若应用在跑，提示并让它被杀掉（CloseApplications 之外兜底）
function InitializeSetup(): Boolean;
begin
  Result := True;
end;
