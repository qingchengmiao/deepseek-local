// DeepSeek Local 启动器（原生，C++/Win32）
//
// 干四件事：
//   1) 单实例：重复双击只把已有窗口叫到前面，不起第二套。
//   2) 拉起应用：先探 8787 的健康接口，没在跑就启 DeepSeek.exe（数据目录指到
//      %LOCALAPPDATA%\DeepSeekLocal\data，装到只读目录也能跑）。
//   3) 托盘常驻：打开应用 / 在浏览器打开 / 内存优化 / 退出。
//   4) 内存优化：定时把应用进程树的 working set 收回去（EmptyWorkingSet 等价），
//      空闲时不占着几百 MB。
//
// 编译：launcher\build.ps1（cl /std:c++17 /EHsc /O2 /MT）

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <string>
#include <vector>
#include <cstdio>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "ws2_32.lib")

static const wchar_t* kMutexName = L"Global\\DeepSeekLocalLauncher_v1";
static const wchar_t* kAppExeName = L"DeepSeek.exe";
static const UINT kTrayMsg = WM_APP + 1;
static const UINT_PTR kTrimTimer = 1;
static const int kDefaultPort = 8787;
static const int kTrimMinutes = 10;

static HWND g_hwnd = nullptr;
static NOTIFYICONDATAW g_nid = {};
static PROCESS_INFORMATION g_child = {};
static bool g_ownedChild = false;
static int g_port = kDefaultPort;   // 应用实际用的端口（8787 被占时由 FindAppPort 更新）
static std::wstring g_appDir;      // 应用根目录（DeepSeek.exe 所在）
static std::wstring g_dataDir;     // 数据目录
static std::wstring g_logPath;

// 最早期诊断：用 CreateFileW 直写一个固定路径（不依赖 CRT / 环境变量）
static void bootMark(const wchar_t* line) {
  const wchar_t* path = L"D:\\Backup\\Documents\\deepseek-harness\\default-workspace\\deepseek-app\\launcher\\out\\boot.log";
  HANDLE h = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                         OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return;
  SYSTEMTIME st;
  GetLocalTime(&st);
  wchar_t buf[512] = {};
  int n = _snwprintf_s(buf, _TRUNCATE, L"%02d:%02d:%02d %s\r\n", st.wHour, st.wMinute, st.wSecond, line);
  if (n > 0) {
    DWORD written = 0;
    WriteFile(h, buf, (DWORD)(n * sizeof(wchar_t)), &written, nullptr);
  }
  CloseHandle(h);
}

static void logLine(const std::wstring& s) {
  // 双写：正常日志 + 临时目录里的 boot 日志（数据目录还没建好时也能留证据）
  wchar_t tmp[MAX_PATH * 2] = {};
  if (GetTempPathW((DWORD)std::size(tmp), tmp)) {
    std::wstring boot = std::wstring(tmp) + L"DeepSeekLauncher-boot.log";
    FILE* bf = nullptr;
    if (_wfopen_s(&bf, boot.c_str(), L"a, ccs=UTF-8") == 0 && bf) {
      SYSTEMTIME st;
      GetLocalTime(&st);
      fwprintf(bf, L"%02d:%02d:%02d %s\n", st.wHour, st.wMinute, st.wSecond, s.c_str());
      fclose(bf);
    }
  }
  if (g_logPath.empty()) return;
  FILE* f = nullptr;
  if (_wfopen_s(&f, g_logPath.c_str(), L"a, ccs=UTF-8") != 0 || !f) return;
  SYSTEMTIME st;
  GetLocalTime(&st);
  fwprintf(f, L"%04d-%02d-%02d %02d:%02d:%02d %s\n", st.wYear, st.wMonth, st.wDay,
           st.wHour, st.wMinute, st.wSecond, s.c_str());
  fclose(f);
}

static std::wstring ExeDir() {
  wchar_t buf[MAX_PATH * 2] = {};
  GetModuleFileNameW(nullptr, buf, (DWORD)std::size(buf));
  std::wstring p(buf);
  size_t pos = p.find_last_of(L"\\/");
  return pos == std::wstring::npos ? p : p.substr(0, pos);
}

static bool FileExists(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static bool DirExists(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

static void EnsureDir(const std::wstring& p) {
  if (DirExists(p)) return;
  // 逐级建（CreateDirectoryW 只建一层，%LOCALAPPDATA%\DeepSeekLocal\data 这种两级路径会静默失败）
  std::wstring cur;
  for (size_t i = 0; i < p.size(); ++i) {
    wchar_t ch = p[i];
    cur.push_back(ch);
    bool sep = (ch == L'\\' || ch == L'/');
    if (!sep && i + 1 != p.size()) continue;
    if (cur.size() >= 3 && cur[1] == L':') {
      // "D:\" 这种根不建
      if (cur.size() == 3) continue;
    }
    if (!DirExists(cur)) CreateDirectoryW(cur.c_str(), nullptr);
  }
}

// 端口上有没有人听：连得上就算在跑（比 HTTP 简单，够用）
static bool PortOpen(int port, int timeoutMs = 400) {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return false;
  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons((u_short)port);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  u_long nonBlock = 1;
  ioctlsocket(s, FIONBIO, &nonBlock);
  connect(s, (sockaddr*)&addr, sizeof(addr));
  fd_set wf, ef;
  FD_ZERO(&wf);
  FD_ZERO(&ef);
  FD_SET(s, &wf);
  FD_SET(s, &ef);
  timeval tv = { timeoutMs / 1000, (timeoutMs % 1000) * 1000 };
  int rc = select(0, nullptr, &wf, &ef, &tv);
  bool ok = rc > 0 && FD_ISSET(s, &wf);
  closesocket(s);
  return ok;
}

// 枚举某个进程的所有后代（含自己）：内存优化要把整棵树都收
static void CollectTree(DWORD rootPid, std::vector<DWORD>& out) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return;
  std::vector<std::pair<DWORD, DWORD>> parentOf;  // pid -> ppid
  PROCESSENTRY32W pe = {};
  pe.dwSize = sizeof(pe);
  if (Process32FirstW(snap, &pe)) {
    do {
      parentOf.emplace_back(pe.th32ProcessID, pe.th32ParentProcessID);
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);

  out.clear();
  out.push_back(rootPid);
  for (size_t i = 0; i < out.size(); ++i) {
    DWORD parent = out[i];
    for (auto& kv : parentOf) {
      if (kv.second != parent || kv.first == parent) continue;
      bool seen = false;
      for (DWORD d : out) if (d == kv.first) { seen = true; break; }
      if (!seen) out.push_back(kv.first);
    }
  }
}

// 把当前所有 DeepSeek 进程的「工作集 / 私有提交」加起来（MB），用于优化前后对比
static void AppMemory(double* wsMB, double* privMB) {
  double ws = 0, pv = 0;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) {
    *wsMB = 0;
    *privMB = 0;
    return;
  }
  std::vector<DWORD> pids;
  PROCESSENTRY32W pe = {};
  pe.dwSize = sizeof(pe);
  if (Process32FirstW(snap, &pe)) {
    do {
      if (_wcsicmp(pe.szExeFile, kAppExeName) == 0) pids.push_back(pe.th32ProcessID);
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  for (DWORD pid : pids) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, FALSE, pid);
    if (!h) continue;
    PROCESS_MEMORY_COUNTERS_EX pmc = {};
    if (GetProcessMemoryInfo(h, (PROCESS_MEMORY_COUNTERS*)&pmc, sizeof(pmc))) {
      ws += (double)pmc.WorkingSetSize / (1024.0 * 1024.0);
      pv += (double)pmc.PrivateUsage / (1024.0 * 1024.0);
    }
    CloseHandle(h);
  }
  *wsMB = ws;
  *privMB = pv;
}

static int TrimWorkingSets() {
  DWORD root = g_ownedChild ? g_child.dwProcessId : 0;
  if (!root) {
    // 不是我们起的（用户先手动开了应用）：按进程名找一下
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap != INVALID_HANDLE_VALUE) {
      PROCESSENTRY32W pe = {};
      pe.dwSize = sizeof(pe);
      if (Process32FirstW(snap, &pe)) {
        do {
          if (_wcsicmp(pe.szExeFile, kAppExeName) == 0) { root = pe.th32ProcessID; break; }
        } while (Process32NextW(snap, &pe));
      }
      CloseHandle(snap);
    }
  }
  std::vector<DWORD> tree;
  if (root) CollectTree(root, tree);
  int done = 0;
  for (DWORD pid : tree) {
    HANDLE h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) continue;
    if (SetProcessWorkingSetSize(h, (SIZE_T)-1, (SIZE_T)-1)) ++done;
    CloseHandle(h);
  }
  // 自己也顺便收一下（托盘进程本来就不大，但省一点是一点）
  SetProcessWorkingSetSize(GetCurrentProcess(), (SIZE_T)-1, (SIZE_T)-1);
  logLine(L"内存优化：" + std::to_wstring(done) + L" 个进程");
  return done;
}

static bool StartApp() {
  std::wstring exe = g_appDir + L"\\" + kAppExeName;
  if (!FileExists(exe)) {
    MessageBoxW(nullptr,
                (L"找不到应用主程序：\n" + exe + L"\n\n请把启动器和 DeepSeek.exe 放在同一个目录里。").c_str(),
                L"DeepSeek Local", MB_ICONERROR | MB_OK);
    return false;
  }
  EnsureDir(g_dataDir);

  std::wstring envBlock;
  {
    // 继承环境，再把 DSAPP_DATA 覆盖成用户数据目录
    LPWCH env = GetEnvironmentStringsW();
    if (env) {
      for (LPWCH p = env; *p;) {
        std::wstring item(p);
        p += item.size() + 1;
        if (item.rfind(L"DSAPP_DATA=", 0) == 0) continue;
        envBlock += item;
        envBlock.push_back(L'\0');
      }
      FreeEnvironmentStringsW(env);
    }
    envBlock += L"DSAPP_DATA=" + g_dataDir;
    envBlock.push_back(L'\0');
    envBlock.push_back(L'\0');
  }

  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_SHOWNORMAL;

  // 起一次；args 为空表示裸启动。返回 false 表示 CreateProcess 就失败。
  auto spawn = [&](const std::wstring& args, PROCESS_INFORMATION* out, DWORD* errOut) -> bool {
    STARTUPINFOW si2 = si;
    PROCESS_INFORMATION pi2 = {};
    std::wstring cmd2 = L"\"" + exe + L"\"" + (args.empty() ? L"" : L" " + args);
    std::vector<wchar_t> buf2(cmd2.begin(), cmd2.end());
    buf2.push_back(L'\0');
    BOOL ok2 = CreateProcessW(exe.c_str(), buf2.data(), nullptr, nullptr, FALSE,
                              CREATE_UNICODE_ENVIRONMENT, (LPVOID)envBlock.data(), g_appDir.c_str(),
                              &si2, &pi2);
    if (!ok2) {
      *errOut = GetLastError();
      return false;
    }
    *out = pi2;
    return true;
  };

  PROCESS_INFORMATION pi = {};
  DWORD err = 0;
  if (!spawn(L"", &pi, &err)) {
    bootMark((L"CreateProcess 失败 err=" + std::to_wstring(err)).c_str());
    MessageBoxW(nullptr, (L"启动失败（错误码 " + std::to_wstring(err) + L"）：\n" + exe).c_str(),
                L"DeepSeek Local", MB_ICONERROR | MB_OK);
    logLine(L"CreateProcess 失败 err=" + std::to_wstring(err));
    return false;
  }
  bootMark((L"已启动应用 pid=" + std::to_wstring(pi.dwProcessId)).c_str());
  logLine(L"已启动应用 pid=" + std::to_wstring(pi.dwProcessId));

  // 有些环境（提权父进程 / 受限令牌）里 Electron 的沙箱初始化会直接退出，
  // 表现是「进程瞬间没了、服务没起」。这种情况用 --no-sandbox 再拉一次。
  DWORD waitFirst = WaitForSingleObject(pi.hProcess, 2500);
  if (waitFirst == WAIT_OBJECT_0) {
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    bootMark((L"裸启动 2.5 秒内退出 code=" + std::to_wstring(code)).c_str());
    logLine(L"裸启动退出 code=" + std::to_wstring(code) + L"，改用 --no-sandbox 重试");
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    PROCESS_INFORMATION pi2 = {};
    if (!spawn(L"--no-sandbox", &pi2, &err)) {
      logLine(L"重试 CreateProcess 失败 err=" + std::to_wstring(err));
      return false;
    }
    pi = pi2;
    bootMark((L"重试启动 pid=" + std::to_wstring(pi.dwProcessId)).c_str());
    logLine(L"重试启动 pid=" + std::to_wstring(pi.dwProcessId));
  } else if (waitFirst == WAIT_TIMEOUT) {
    bootMark(L"裸启动存活 2.5 秒");
    logLine(L"裸启动存活 2.5 秒");
  }
  g_child = pi;
  g_ownedChild = true;

  // 等服务器起来（最多 40 秒）；应用可能落在 8787 之后的端口上，所以扫一段
  for (int i = 0; i < 80; ++i) {
    int p = 0;
    for (int t = 0; t < 18 && !p; ++t) {
      if (PortOpen(kDefaultPort + t, 120)) p = kDefaultPort + t;
    }
    if (p) {
      g_port = p;
      bootMark((L"服务就绪 port=" + std::to_wstring(p)).c_str());
      logLine(L"服务就绪 port=" + std::to_wstring(p));
      return true;
    }
    if (WaitForSingleObject(pi.hProcess, 0) == WAIT_OBJECT_0) {
      DWORD code = 0;
      GetExitCodeProcess(pi.hProcess, &code);
      bootMark((L"等待中应用退出 code=" + std::to_wstring(code) + L" i=" + std::to_wstring(i)).c_str());
      logLine(L"等待中应用退出 code=" + std::to_wstring(code));
      break;
    }
    Sleep(500);
  }
  logLine(L"服务没起来（应用窗口可能已经出来了，先看看窗口）");
  return true;
}

// 应用自己会挑端口（8787 被占就往后挪），所以这里也扫一段
static int FindAppPort(int tries = 18) {
  for (int i = 0; i < tries; ++i) {
    int p = kDefaultPort + i;
    if (PortOpen(p, 120)) return p;
  }
  return 0;
}

static void OpenInBrowser() {
  std::wstring url = L"http://127.0.0.1:" + std::to_wstring(g_port) + L"/";
  ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

static void ShowAppWindow() {
  // Electron 主窗口的类名是 Chrome_WidgetWin_1，标题里带 DeepSeek。
  // 只认 DeepSeek.exe 的窗口——浏览器标签也可能叫 "DeepSeek Local"，别把浏览器拉到前台。
  struct Ctx { bool found; } ctx{false};
  EnumWindows([](HWND h, LPARAM lp) -> BOOL {
    wchar_t title[256] = {};
    GetWindowTextW(h, title, 255);
    if (!wcsstr(title, L"DeepSeek")) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    if (!pid) return TRUE;
    bool mine = false;
    HANDLE hp = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hp) {
      wchar_t exe[MAX_PATH] = {};
      DWORD n = MAX_PATH;
      if (QueryFullProcessImageNameW(hp, 0, exe, &n)) {
        const wchar_t* base = wcsrchr(exe, L'\\');
        mine = _wcsicmp(base ? base + 1 : exe, kAppExeName) == 0;
      }
      CloseHandle(hp);
    }
    if (!mine) return TRUE;
    ShowWindow(h, SW_RESTORE);
    SetForegroundWindow(h);
    *(bool*)lp = true;
    return FALSE;
  }, (LPARAM)&ctx.found);
  if (!ctx.found) StartApp();
}

static void RemoveTray() {
  if (g_nid.cbSize) Shell_NotifyIconW(NIM_DELETE, &g_nid);
}

static void QuitAll() {
  RemoveTray();
  if (g_ownedChild && g_child.hProcess) {
    // 先温柔后强硬：关窗口的消息发不到（Electron 在子进程里），直接杀树
    std::wstring cmd = L"taskkill /PID " + std::to_wstring(g_child.dwProcessId) + L" /T /F";
    std::vector<wchar_t> buf(cmd.begin(), cmd.end());
    buf.push_back(L'\0');
    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi = {};
    if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                       nullptr, &si, &pi)) {
      WaitForSingleObject(pi.hProcess, 5000);
      CloseHandle(pi.hProcess);
      CloseHandle(pi.hThread);
    }
    logLine(L"已退出应用");
  }
  PostQuitMessage(0);
}

static void ShowTrayMenu(HWND hwnd) {
  POINT pt;
  GetCursorPos(&pt);
  HMENU menu = CreatePopupMenu();
  AppendMenuW(menu, MF_STRING, 1, L"打开应用");
  AppendMenuW(menu, MF_STRING, 2, L"在浏览器打开");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, 3, L"内存优化");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, 4, L"退出");
  SetForegroundWindow(hwnd);
  UINT cmd = (UINT)TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, nullptr);
  DestroyMenu(menu);
  switch (cmd) {
    case 1: ShowAppWindow(); break;
    case 2: OpenInBrowser(); break;
    case 3: {
      int n = TrimWorkingSets();
      NOTIFYICONDATAW tip = g_nid;
      wcsncpy_s(tip.szInfo, (L"已回收 " + std::to_wstring(n) + L" 个进程的工作集").c_str(), _TRUNCATE);
      tip.uFlags = NIF_INFO;
      tip.dwInfoFlags = NIIF_INFO;
      Shell_NotifyIconW(NIM_MODIFY, &tip);
      break;
    }
    case 4: QuitAll(); break;
    default: break;
  }
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case kTrayMsg:
      if (LOWORD(lp) == WM_RBUTTONUP || LOWORD(lp) == WM_LBUTTONUP) ShowTrayMenu(hwnd);
      else if (LOWORD(lp) == WM_LBUTTONDBLCLK) ShowAppWindow();
      return 0;
    case WM_TIMER:
      if (wp == kTrimTimer) TrimWorkingSets();
      return 0;
    case WM_DESTROY:
      RemoveTray();
      PostQuitMessage(0);
      return 0;
    default: break;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int) {
  bootMark(L"wWinMain 进入");
  logLine(L"boot 开始");

  // --trim：只做一次内存回收然后退出（脚本调用 / 排错用，不受单实例限制）
  if (wcsstr(GetCommandLineW(), L"--trim")) {
    double ws0 = 0, pv0 = 0, ws1 = 0, pv1 = 0;
    AppMemory(&ws0, &pv0);
    const int n = TrimWorkingSets();
    AppMemory(&ws1, &pv1);
    wchar_t buf[320] = {};
    _snwprintf_s(buf, _TRUNCATE,
                 L"trim 回收=%d 个进程｜工作集 %.1f→%.1f MB（页挪到 standby）｜私有提交 %.1f→%.1f MB（不变）",
                 n, ws0, ws1, pv0, pv1);
    bootMark(buf);
    return 0;
  }
  // 单实例：拿不到就说明已经有一个在托盘里了，安静退出
  SetLastError(0);
  HANDLE mutex = CreateMutexW(nullptr, TRUE, kMutexName);
  const DWORD mutexErr = GetLastError();   // 必须立刻取，后面写日志会覆盖 GetLastError
  bootMark((L"CreateMutexW err=" + std::to_wstring(mutexErr)).c_str());
  if (!mutex || mutexErr == ERROR_ALREADY_EXISTS) {
    bootMark((L"已有实例，唤起窗口后退出 err=" + std::to_wstring(mutexErr)).c_str());
    logLine(L"已有实例在跑，唤起窗口后退出");
    ShowAppWindow();
    return 0;
  }

  g_appDir = ExeDir();
  bootMark(g_appDir.c_str());
  logLine(L"appDir=" + g_appDir);
  // 启动器可能放在子目录里（安装包就是 launcher\ 下）：往上找一层有 DeepSeek.exe 的
  if (!FileExists(g_appDir + L"\\" + kAppExeName)) {
    std::wstring parent = g_appDir;
    size_t pos = parent.find_last_of(L"\\/");
    if (pos != std::wstring::npos) {
      parent = parent.substr(0, pos);
      if (FileExists(parent + L"\\" + kAppExeName)) g_appDir = parent;
    }
  }

  // 数据目录优先级：显式 DSAPP_DATA > 应用目录里已有的 data（开发/打包版的 junction）
  // > %LOCALAPPDATA%\DeepSeekLocal\data（安装版，装到只读目录也能写）
  wchar_t localApp[MAX_PATH * 2] = {};
  const std::wstring portableData = g_appDir + L"\\data";
  if (DirExists(portableData + L"\\conversations")) {
    g_dataDir = portableData;
  } else if (GetEnvironmentVariableW(L"LOCALAPPDATA", localApp, (DWORD)std::size(localApp))) {
    g_dataDir = std::wstring(localApp) + L"\\DeepSeekLocal\\data";
  } else {
    g_dataDir = portableData;
  }
  if (GetEnvironmentVariableW(L"DSAPP_DATA", localApp, (DWORD)std::size(localApp))) {
    g_dataDir = localApp;
  }
  logLine(L"dataDir=" + g_dataDir);
  EnsureDir(g_dataDir);
  logLine(L"dataDir 建好=" + std::to_wstring(DirExists(g_dataDir)));
  g_logPath = g_dataDir + L"\\launcher.log";

  WSADATA wsa = {};
  WSAStartup(MAKEWORD(2, 2), &wsa);

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.lpszClassName = L"DeepSeekLocalLauncherWnd";
  RegisterClassExW(&wc);
  g_hwnd = CreateWindowExW(0, wc.lpszClassName, L"DeepSeek Local", 0, 0, 0, 0, 0, HWND_MESSAGE,
                           nullptr, hInst, nullptr);

  // 托盘图标直接用应用的 exe 图标（没有就退回系统信息图标）
  HICON icon = nullptr;
  std::wstring appExe = g_appDir + L"\\" + kAppExeName;
  if (FileExists(appExe)) {
    HICON big = nullptr, small = nullptr;
    if (ExtractIconExW(appExe.c_str(), 0, &big, &small, 1) > 0) {
      icon = small ? small : big;
    }
  }
  if (!icon) icon = LoadIconW(nullptr, IDI_APPLICATION);

  g_nid.cbSize = sizeof(g_nid);
  g_nid.hWnd = g_hwnd;
  g_nid.uID = 1;
  g_nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  g_nid.uCallbackMessage = kTrayMsg;
  g_nid.hIcon = icon;
  wcsncpy_s(g_nid.szTip, L"DeepSeek Local（双击打开）", _TRUNCATE);
  Shell_NotifyIconW(NIM_ADD, &g_nid);

  logLine(L"启动器就绪 app=" + g_appDir + L" data=" + g_dataDir);

  // 已经有应用在跑（端口任意一个通）就不重复起服务；但窗口不一定还在
  // （常见：服务被我重启过、或窗口被关掉只剩服务），所以先找窗口，找不到就仍要拉起应用
  int running = FindAppPort();
  if (running) {
    g_port = running;
    logLine(L"已有服务在跑 port=" + std::to_wstring(running));
    ShowAppWindow();
  } else {
    StartApp();
  }

  SetTimer(g_hwnd, kTrimTimer, (UINT)kTrimMinutes * 60 * 1000, nullptr);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  WSACleanup();
  if (mutex) CloseHandle(mutex);
  return 0;
}
