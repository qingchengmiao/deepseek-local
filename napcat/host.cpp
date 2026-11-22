// DSLNapCatHost.exe —— DeepSeek Local 的 NapCat 宿主（C++，无第三方依赖）
//
// 干的事：把一份独立复制出来的 NapCat Shell（含它自己的 QQ.exe + 注入 hook）
// 拉起来、看住它、并在收到命令时只杀“自己那一份”进程。
//
// 为什么不直接用 bat：
//   1) taskkill /im QQ.exe 会杀掉别的实例和用户自己的 QQ —— 这里按可执行文件路径前缀判定归属；
//   2) bat 不能常驻看门狗、不能对外报状态；
//   3) 需要把“起没起 / 登录没登录 / 二维码新不新”变成机器可读的状态给 DeepSeek Local 用。
//
// 用法：
//   DSLNapCatHost.exe [选项] <stop|start|status|run|qr>
//   选项（都有默认值，也可用环境变量）：
//     --shell DIR        NapCat Shell 目录（默认 %DSLNAPCAT_SHELL% 或 D:\NapCatDSL\Shell）
//     --workdir DIR      NapCat 数据/配置目录（默认 %DSLNAPCAT_WORKDIR% 或 同级 config）
//     --http-port N      OneBot HTTP 端口，只用于探活与上报（默认 3200）
//     --ws-port N        OneBot WS 端口（默认 3201）
//     --webui-port N     WebUI 端口（默认 6209）
//     --status FILE      状态 JSON 路径（默认 workdir\host-status.json）
//     --github           兼容占位，无效果
//   run 是前台看门狗；start 起完就返回；status 打印 JSON 到 stdout。
//
// 退出码：0 成功；1 参数/环境错误；2 启动失败；3 已在运行（start 用）。

#define WIN32_LEAN_AND_MEAN
#define _WINSOCKAPI_
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <tlhelp32.h>
#include <shellapi.h>
#include <wbemidl.h>
#include <comdef.h>
#include <string>
#include <vector>
#include <cstdio>
#include <cstring>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "wbemuuid.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")

namespace {

struct Options {
  std::wstring shell;
  std::wstring workdir;
  // QQ 的独立登录态目录（--user-data-dir）。不设它的话 QQ 会读到系统里
  // %APPDATA%\QQ 那份共享 profile，直接快速登录成别的号、永远不出二维码。
  std::wstring login;
  int httpPort = 3200;
  int wsPort = 3201;
  int webuiPort = 6209;
  std::wstring statusFile;
  std::wstring command = L"status";
  bool workdirExplicit = false;
  int waitQrSeconds = 0;
  int intervalSeconds = 10;
};

std::wstring ExeDir() {
  wchar_t buf[MAX_PATH * 2] = {0};
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH * 2);
  std::wstring p(buf, n ? n : 0);
  size_t slash = p.find_last_of(L"\\/");
  return slash == std::wstring::npos ? L"." : p.substr(0, slash);
}

std::wstring EnvOr(const wchar_t* name, const std::wstring& fallback) {
  wchar_t buf[4096] = {0};
  DWORD n = GetEnvironmentVariableW(name, buf, 4096);
  if (n == 0 || n >= 4096) return fallback;
  return std::wstring(buf, n);
}

std::wstring JoinPath(const std::wstring& a, const std::wstring& b) {
  if (a.empty()) return b;
  wchar_t last = a.back();
  if (last == L'\\' || last == L'/') return a + b;
  return a + L"\\" + b;
}

bool FileExists(const std::wstring& p) {
  DWORD attr = GetFileAttributesW(p.c_str());
  return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

bool DirExists(const std::wstring& p) {
  DWORD attr = GetFileAttributesW(p.c_str());
  return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY);
}

void EnsureDir(const std::wstring& p) {
  if (p.empty() || DirExists(p)) return;
  EnsureDir(p.substr(0, p.find_last_of(L"\\/")));
  CreateDirectoryW(p.c_str(), nullptr);
}

std::wstring Lower(std::wstring s) {
  for (auto& c : s) c = (wchar_t)towlower(c);
  return s;
}

bool StartsWithNoCase(const std::wstring& s, const std::wstring& prefix) {
  if (prefix.size() > s.size()) return false;
  return Lower(s.substr(0, prefix.size())) == Lower(prefix);
}

// 取出某个进程的可执行文件完整路径（拿不到返回空）
std::wstring ProcessImagePath(DWORD pid) {
  std::wstring out;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return out;
  wchar_t buf[MAX_PATH * 2] = {0};
  DWORD size = MAX_PATH * 2;
  if (QueryFullProcessImageNameW(h, 0, buf, &size)) out.assign(buf, size);
  CloseHandle(h);
  return out;
}

// 只列本实例的进程。
// 判两条：① 可执行文件路径落在 shell 目录下（主进程一定满足）
//         ② 或它的祖先进程已经是本实例的（QQ 的 gpu/utility 子进程有时拿不到路径）
// 这两条缺一不可 —— 只按进程名会杀到别的实例和用户自己的 QQ；只按路径会漏掉子进程。
struct ProcEntry {
  DWORD pid;
  DWORD ppid;
  std::wstring path;
  std::wstring name;
};

// 只有这两类进程可能属于本实例；其余一律不碰（尤其是用户自己的 QQ 客户端）。
bool OwnProcName(const std::wstring& name) {
  return Lower(name) == L"qq.exe" || Lower(name) == L"napcatwinbootmain.exe";
}

std::wstring VarStr(VARIANT& v) {
  if (v.vt != VT_BSTR || !v.bstrVal) return L"";
  return std::wstring(v.bstrVal, SysStringLen(v.bstrVal));
}

DWORD VarUint(VARIANT& v) {
  if (v.vt == VT_I4) return (DWORD)v.lVal;
  if (v.vt == VT_UI4) return (DWORD)v.ulVal;
  if (v.vt == VT_I2) return (DWORD)v.iVal;
  if (v.vt == VT_UI2) return (DWORD)v.uiVal;
  if (v.vt == VT_BSTR && v.bstrVal) return (DWORD)_wtoi(v.bstrVal);
  return 0;
}

// 只跑一条 WQL 取候选进程表。where 传 nullptr 表示取全表（由调用方自己过滤）。
std::vector<ProcEntry> WmiQuery(const wchar_t* where) {
  std::vector<ProcEntry> out;
  IWbemLocator* loc = nullptr;
  IWbemServices* svc = nullptr;
  IEnumWbemClassObject* en = nullptr;
  if (FAILED(CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER, IID_IWbemLocator,
                              (void**)&loc)))
    return out;
  if (FAILED(loc->ConnectServer(_bstr_t(L"ROOT\\CIMV2"), nullptr, nullptr, nullptr, 0, nullptr,
                                nullptr, &svc))) {
    loc->Release();
    return out;
  }
  CoSetProxyBlanket(svc, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr, RPC_C_AUTHN_LEVEL_CALL,
                    RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE);

  std::wstring wql =
      L"SELECT ProcessId,ParentProcessId,Name,ExecutablePath FROM Win32_Process";
  if (where) {
    wql += L" WHERE ";
    wql += where;
  }
  bool dbgW = GetEnvironmentVariableW(L"DSLHOST_DEBUG", nullptr, 0) > 0;
  HRESULT hrExec = svc->ExecQuery(_bstr_t(L"WQL"), _bstr_t(wql.c_str()),
                                  WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, nullptr,
                                  &en);
  if (dbgW)
    fprintf(stderr, "[wmi] ExecQuery(where=%ls) hr=0x%08lx\n", where ? where : L"(全表)",
            (unsigned long)hrExec);
  if (SUCCEEDED(hrExec) && en) {
    for (;;) {
      IWbemClassObject* obj = nullptr;
      ULONG got = 0;
      HRESULT hrNext = en->Next((LONG)WBEM_INFINITE, 1, &obj, &got);
      if (hrNext != S_OK || !got || !obj) break;
      ProcEntry e{};
      VARIANT v;
      VariantInit(&v);
      if (SUCCEEDED(obj->Get(L"ProcessId", 0, &v, nullptr, nullptr))) e.pid = VarUint(v);
      VariantClear(&v);
      VariantInit(&v);
      if (SUCCEEDED(obj->Get(L"ParentProcessId", 0, &v, nullptr, nullptr))) e.ppid = VarUint(v);
      VariantClear(&v);
      VariantInit(&v);
      if (SUCCEEDED(obj->Get(L"Name", 0, &v, nullptr, nullptr))) e.name = VarStr(v);
      VariantClear(&v);
      VariantInit(&v);
      if (SUCCEEDED(obj->Get(L"ExecutablePath", 0, &v, nullptr, nullptr))) e.path = VarStr(v);
      VariantClear(&v);
      if (e.pid) out.push_back(e);
      obj->Release();
    }
    en->Release();
  }
  svc->Release();
  loc->Release();
  if (dbgW) fprintf(stderr, "[wmi] 这次拿到 %zu 行\n", out.size());
  return out;
}

// 用 WMI 取 QQ / NapCatWinBootMain 的进程表。
// 为什么不用 OpenProcess+QueryFullProcessImageName：QQ 带反作弊保护，实测大部分子进程
// 连管理员都打不开（返回空路径），只按路径判定会漏掉 3/4 的进程，stop 也杀不干净。
// 坑（2026-11-23）：带 WHERE Name=... 的 WQL 在本进程里只回 1 行（PowerShell 同一条却回 5 行），
// 所以先试窄查询，行数不足就退化成全表查询 + 本地按名字过滤，两条路取并集。
// 用 Toolhelp 取全表：进程名永远读得到（QQ 的反作弊只挡「读别人路径」，不挡进程枚举），
// 比 WMI 稳。实测（2026-11-23）本进程里 WMI 只看得见 17 个进程、窄查询只回 1 行，
// 而 Toolhelp 能看见全部 —— 所以以 Toolhelp 为主，WMI 只用来补路径信息。
std::vector<ProcEntry> QueryProcsToolhelp() {
  std::vector<ProcEntry> all;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return all;
  PROCESSENTRY32W pe;
  pe.dwSize = sizeof(pe);
  if (Process32FirstW(snap, &pe)) {
    do {
      ProcEntry e{};
      e.pid = pe.th32ProcessID;
      e.ppid = pe.th32ParentProcessID;
      e.name = pe.szExeFile;
      if (e.pid && e.pid != GetCurrentProcessId()) all.push_back(e);
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  return all;
}

std::vector<ProcEntry> QueryProcsWmi() {
  HRESULT hrInit = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool needUninit = SUCCEEDED(hrInit);
  std::vector<ProcEntry> all = WmiQuery(L"Name='QQ.exe' OR Name='NapCatWinBootMain.exe'");
  if (all.size() < 2) {
    std::vector<ProcEntry> full = WmiQuery(nullptr);
    for (auto& e : full) {
      if (!OwnProcName(e.name)) continue;
      bool dup = false;
      for (auto& x : all)
        if (x.pid == e.pid) { dup = true; break; }
      if (!dup) all.push_back(e);
    }
  }
  if (needUninit) CoUninitialize();
  return all;
}

std::vector<DWORD> OwnPids(const std::wstring& shell) {
  std::vector<ProcEntry> all = QueryProcsToolhelp();
  bool dbg = GetEnvironmentVariableW(L"DSLHOST_DEBUG", nullptr, 0) > 0;
  if (dbg) {
    size_t cand = 0;
    for (auto& e : all) if (OwnProcName(e.name)) ++cand;
    fprintf(stderr, "[host][debug] Toolhelp 全表 %zu 个进程，其中 QQ/boot 候选 %zu 个（shell=%ls）\n",
            all.size(), cand, shell.c_str());
    for (auto& e : all)
      fprintf(stderr, "[host][debug] 表项 pid=%lu ppid=%lu name=%ls\n", e.pid, e.ppid, e.name.c_str());
  }
  if (all.empty()) return {};

  // 路径能读就读（绝大部分 QQ.exe 读得到；个别子进程读不到，靠父链补）
  for (auto& e : all) e.path = ProcessImagePath(e.pid);
  if (dbg)
    for (auto& e : all)
      if (OwnProcName(e.name))
        fprintf(stderr, "[host][debug]   pid=%lu ppid=%lu name=%ls path=%ls\n", e.pid, e.ppid,
                e.name.c_str(), e.path.c_str());

  std::vector<bool> own(all.size(), false);
  for (size_t i = 0; i < all.size(); ++i) {
    if (!OwnProcName(all[i].name)) continue;
    if (!all[i].path.empty() && StartsWithNoCase(all[i].path, shell)) own[i] = true;
  }
  // 沿父链双向补齐：向下收子进程，向上收父进程（都限定在 QQ.exe / NapCatWinBootMain.exe）。
  for (int round = 0; round < 8; ++round) {
    bool changed = false;
    for (size_t i = 0; i < all.size(); ++i) {
      if (own[i] || all[i].ppid == 0 || !OwnProcName(all[i].name)) continue;
      bool parentOwn = false;
      for (size_t j = 0; j < all.size(); ++j) {
        if (all[j].pid == all[i].ppid && own[j]) { parentOwn = true; break; }
      }
      if (parentOwn) { own[i] = true; changed = true; continue; }
      for (size_t j = 0; j < all.size(); ++j) {
        if (all[j].ppid == all[i].pid && own[j]) { own[i] = true; changed = true; break; }
      }
    }
    if (!changed) break;
  }

  std::vector<DWORD> pids;
  for (size_t i = 0; i < all.size(); ++i)
    if (own[i]) pids.push_back(all[i].pid);
  if (dbg) fprintf(stderr, "[host][debug] 判定属于本实例的进程 %zu 个\n", pids.size());
  return pids;
}

bool PortOpen(int port, const wchar_t* host = L"127.0.0.1") {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return false;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons((u_short)port);
  InetPtonW(AF_INET, host, &addr.sin_addr);
  bool ok = connect(s, (sockaddr*)&addr, sizeof(addr)) == 0;
  closesocket(s);
  return ok;
}

void InitWinsock() {
  static bool done = false;
  if (done) return;
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
  done = true;
}

std::string Narrow(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

std::string JsonEscape(const std::string& in) {
  std::string out;
  for (char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) {
          char buf[8];
          sprintf_s(buf, "\\u%04x", (unsigned char)c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

struct QrInfo {
  bool exists = false;
  unsigned long long size = 0;
  long long mtime = 0;
  std::wstring path;
};

QrInfo ReadQr(const std::wstring& shell) {
  QrInfo q;
  q.path = JoinPath(shell, L"cache\\qrcode.png");
  WIN32_FILE_ATTRIBUTE_DATA fad{};
  if (GetFileAttributesExW(q.path.c_str(), GetFileExInfoStandard, &fad)) {
    q.exists = true;
    q.size = ((unsigned long long)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;
    ULARGE_INTEGER t;
    t.HighPart = fad.ftLastWriteTime.dwHighDateTime;
    t.LowPart = fad.ftLastWriteTime.dwLowDateTime;
    // FILETIME(1601) → Unix 秒
    q.mtime = (long long)((t.QuadPart - 116444736000000000ULL) / 10000000ULL);
  }
  return q;
}

std::string NowIso() {
  SYSTEMTIME st;
  GetLocalTime(&st);
  char buf[32];
  sprintf_s(buf, "%04d-%02d-%02dT%02d:%02d:%02d", st.wYear, st.wMonth, st.wDay, st.wHour,
            st.wMinute, st.wSecond);
  return std::string(buf);
}

// 看门狗的失败计数与一句提示。written into 状态文件，UI 与排查都看它。
// 意义：进程反复起不来时（典型原因是登录 profile 被写坏，QQ 起来 20 秒就退出），
// 不能无脑快速重启刷屏，要退到 10 分钟一轮并留话给人看。
static int g_fails = 0;
static std::string g_warning;

std::string BuildStatusJson(const Options& o, const std::vector<DWORD>& pids, bool httpUp,
                            const char* phase) {
  InitWinsock();
  QrInfo qr = ReadQr(o.shell);
  bool running = !pids.empty();
  std::string pidsJson;
  for (size_t i = 0; i < pids.size(); ++i) {
    if (i) pidsJson += ", ";
    pidsJson += std::to_string(pids[i]);
  }
  std::string s;
  s += "{\n";
  s += "  \"ok\": true,\n";
  s += "  \"phase\": \"" + JsonEscape(phase ? phase : "") + "\",\n";
  s += "  \"running\": " + std::string(running ? "true" : "false") + ",\n";
  s += "  \"pids\": [" + pidsJson + "],\n";
  s += "  \"processCount\": " + std::to_string(pids.size()) + ",\n";
  s += "  \"httpPort\": " + std::to_string(o.httpPort) + ",\n";
  s += "  \"wsPort\": " + std::to_string(o.wsPort) + ",\n";
  s += "  \"webuiPort\": " + std::to_string(o.webuiPort) + ",\n";
  s += "  \"httpUp\": " + std::string(httpUp ? "true" : "false") + ",\n";
  s += "  \"loggedIn\": " + std::string((running && httpUp) ? "true" : "false") + ",\n";
  s += "  \"shell\": \"" + JsonEscape(Narrow(o.shell)) + "\",\n";
  s += "  \"workdir\": \"" + JsonEscape(Narrow(o.workdir)) + "\",\n";
  s += "  \"login\": \"" + JsonEscape(Narrow(o.login)) + "\",\n";
  s += "  \"qrExists\": " + std::string(qr.exists ? "true" : "false") + ",\n";
  s += "  \"qrPath\": \"" + JsonEscape(Narrow(qr.path)) + "\",\n";
  s += "  \"qrMtime\": " + std::to_string(qr.mtime) + ",\n";
  s += "  \"qrSize\": " + std::to_string(qr.size) + ",\n";
  // 连续失败次数与一句人话提示：长期托管时靠它判断「是不是需要人来扫码/重置登录目录」
  s += "  \"fails\": " + std::to_string(g_fails) + ",\n";
  s += "  \"warning\": \"" + JsonEscape(g_warning) + "\",\n";
  s += "  \"ts\": \"" + NowIso() + "\"\n";
  s += "}\n";
  return s;
}

// 从状态文件里把「连续失败次数 / 提示」读回来。只给 status 用：
// 这两个值平时只活在超管进程的内存里，别人（应用、人）只能从状态文件看见。
std::string ReadTextFile(const std::wstring& p) {
  HANDLE h = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return {};
  char buf[4096];
  DWORD got = 0;
  std::string out;
  while (ReadFile(h, buf, sizeof(buf), &got, nullptr) && got) out.append(buf, got);
  CloseHandle(h);
  return out;
}

// 只认本程序自己写的那种 JSON：找 "key"，跳过冒号和空白，取数字/字符串。够用就行。
int ParseJsonInt(const std::string& body, const char* key) {
  std::string pat = std::string("\"") + key + "\"";
  size_t i = body.find(pat);
  if (i == std::string::npos) return 0;
  i = body.find(':', i + pat.size());
  if (i == std::string::npos) return 0;
  ++i;
  while (i < body.size() && (body[i] == ' ' || body[i] == '\t')) ++i;
  return atoi(body.c_str() + i);
}

std::string ParseJsonString(const std::string& body, const char* key) {
  std::string pat = std::string("\"") + key + "\"";
  size_t i = body.find(pat);
  if (i == std::string::npos) return {};
  i = body.find('"', body.find(':', i + pat.size()));
  if (i == std::string::npos) return {};
  std::string out;
  for (++i; i < body.size() && body[i] != '"'; ++i) {
    if (body[i] == '\\' && i + 1 < body.size()) {
      char c = body[++i];
      if (c == 'n') out += '\n';
      else if (c == 't') out += '\t';
      else if (c == 'r') out += '\r';
      else out += c;
    } else {
      out += body[i];
    }
  }
  return out;
}

void LoadPersistedStatus(const Options& o) {
  if (o.statusFile.empty()) return;
  std::string body = ReadTextFile(o.statusFile);
  if (body.empty()) return;
  int fails = ParseJsonInt(body, "fails");
  if (fails > 0) g_fails = fails;
  std::string warn = ParseJsonString(body, "warning");
  if (!warn.empty()) g_warning = warn;
}

void WriteStatus(const Options& o, const std::vector<DWORD>& pids, bool httpUp, const char* phase) {
  if (o.statusFile.empty()) return;
  EnsureDir(o.statusFile.substr(0, o.statusFile.find_last_of(L"\\/")));
  std::string json = BuildStatusJson(o, pids, httpUp, phase);
  HANDLE h = CreateFileW(o.statusFile.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                         CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(h, json.data(), (DWORD)json.size(), &written, nullptr);
  CloseHandle(h);
}

// 记录/读取「我们自己 start 出来的那个 launcher 的 pid」。
// 为什么要记：某些环境（比如程序放在被安全软件/sandbox 打理的目录里）会让进程枚举只看见
// 自己那一小撮进程，OwnPids() 就判不全；这时候还能靠这个 pid 用 taskkill /T 整棵树带走。
std::wstring RootPidFile(const Options& o) {
  std::wstring dir = o.statusFile.empty() ? ExeDir() : o.statusFile.substr(0, o.statusFile.find_last_of(L"\\/"));
  return JoinPath(dir, L"root.pid");
}

void SaveRootPid(const Options& o, DWORD pid) {
  std::wstring f = RootPidFile(o);
  EnsureDir(f.substr(0, f.find_last_of(L"\\/")));
  FILE* fp = nullptr;
  if (_wfopen_s(&fp, f.c_str(), L"wb") == 0 && fp) {
    fprintf(fp, "%lu", pid);
    fclose(fp);
  }
}

DWORD LoadRootPid(const Options& o) {
  std::wstring f = RootPidFile(o);
  FILE* fp = nullptr;
  if (_wfopen_s(&fp, f.c_str(), L"rb") != 0 || !fp) return 0;
  unsigned long pid = 0;
  fscanf_s(fp, "%lu", &pid);
  fclose(fp);
  return (DWORD)pid;
}

int StopOwn(const Options& o) {
  std::vector<DWORD> pids = OwnPids(o.shell);
  int killed = 0;
  // 先杀 boot main，再杀 QQ；两轮，避免 QQ 重启自拉起
  for (int round = 0; round < 2; ++round) {
    for (DWORD pid : pids) {
      HANDLE h = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
      if (!h) continue;
      if (TerminateProcess(h, 0)) ++killed;
      WaitForSingleObject(h, 3000);
      CloseHandle(h);
    }
    Sleep(500);
    pids = OwnPids(o.shell);
    if (pids.empty()) break;
  }
  // 枚举看不见全部进程时（沙箱/安全软件会把进程表裁掉），退回「按记录的 launcher pid 整棵树带走」。
  // 用 taskkill /T 是因为它自己会沿父链收子进程，不依赖我们的枚举结果。
  if (killed < 2) {
    DWORD root = LoadRootPid(o);
    if (root) {
      std::wstring cmd = L"taskkill /PID " + std::to_wstring(root) + L" /T /F";
      STARTUPINFOW si{};
      si.cb = sizeof(si);
      si.dwFlags = STARTF_USESHOWWINDOW;
      si.wShowWindow = SW_HIDE;
      PROCESS_INFORMATION pi{};
      std::vector<wchar_t> buf(cmd.begin(), cmd.end());
      buf.push_back(0);
      if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                         nullptr, &si, &pi)) {
        WaitForSingleObject(pi.hProcess, 15000);
        DWORD code = 1;
        GetExitCodeProcess(pi.hProcess, &code);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        if (code == 0) killed = (killed < 2 ? 2 : killed);
      }
    }
  }
  return killed;
}

bool SetEnvPair(const wchar_t* name, const std::wstring& value) {
  return SetEnvironmentVariableW(name, value.c_str()) != FALSE;
}

int StartOwn(const Options& o, int waitQrSeconds) {
  InitWinsock();
  if (!DirExists(o.shell)) {
    fprintf(stderr, "[host] shell 目录不存在：%s\n", Narrow(o.shell).c_str());
    return 1;
  }
  std::wstring launcher = JoinPath(o.shell, L"NapCatWinBootMain.exe");
  std::wstring qq = JoinPath(o.shell, L"QQ.exe");
  std::wstring hook = JoinPath(o.shell, L"NapCatWinBootHook.dll");
  if (!FileExists(launcher) || !FileExists(qq) || !FileExists(hook)) {
    fprintf(stderr, "[host] shell 目录缺文件（需要 NapCatWinBootMain.exe / QQ.exe / NapCatWinBootHook.dll）：%s\n",
            Narrow(o.shell).c_str());
    return 1;
  }

  std::vector<DWORD> pids = OwnPids(o.shell);
  if (!pids.empty()) {
    fprintf(stdout, "[host] 已经在跑（%zu 个进程），不重复启动\n", pids.size());
    WriteStatus(o, pids, PortOpen(o.httpPort), "already-running");
    return 3;
  }

  EnsureDir(o.workdir);
  EnsureDir(o.login);
  // 这五个变量是 NapCat 注入的唯一入口，漏一个就静默失败（boot main 起了、QQ 不起）
  SetEnvPair(L"NAPCAT_PATCH_PACKAGE", JoinPath(o.shell, L"qqnt.json"));
  SetEnvPair(L"NAPCAT_LOAD_PATH", JoinPath(o.shell, L"loadNapCat.js"));
  SetEnvPair(L"NAPCAT_INJECT_PATH", hook);
  SetEnvPair(L"NAPCAT_LAUNCHER_PATH", launcher);
  SetEnvPair(L"NAPCAT_MAIN_PATH", JoinPath(o.shell, L"napcat.mjs"));
  // 注意：默认不设 NAPCAT_WORKDIR。
  // 实测（2026-11-23）：给一个空目录当 workdir，boot main 会把 QQ 拉起来后立刻退出
  // （日志只有 Process resumed 然后 Process exited），看着像注入失败，其实是数据目录不对。
  // 本实例用的是独立复制出来的 Shell，配置本来就跟着它走，不需要再指 workdir。
  if (o.workdirExplicit) {
    EnsureDir(o.workdir);
    SetEnvPair(L"NAPCAT_WORKDIR", o.workdir);
  } else {
    SetEnvironmentVariableW(L"NAPCAT_WORKDIR", nullptr);
  }
  SetEnvPair(L"NAPCAT_WEBUI_PREFERRED_PORT", std::to_wstring(o.webuiPort));

  // 关键：把我们自己的登录目录透传给 QQ。NapCat 的 boot main 会把多余的参数原样
  // 交给 QQ.exe，所以这一句决定了它读不到系统共享 profile、必须让我们扫码登录。
  std::wstring cmd = L"\"" + launcher + L"\" \"" + qq + L"\" \"" + hook + L"\" \"" +
                     L"--user-data-dir=" + o.login + L"\"";
  std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
  cmdBuf.push_back(L'\0');

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  // 把自己的标准句柄直接交给子进程继承（不做重定向，也没把句柄关成 NULL）。
  // 实测：bInheritHandles=FALSE 且不给 STARTF_USESTDHANDLES 时，QQ 起来会立刻退出。
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION pi{};
  // 关键：不做任何 stdio 重定向。历史上把 NapCatWinBootMain 的输出重定向到文件会让它起不来。
  DWORD flags = CREATE_UNICODE_ENVIRONMENT;
  BOOL ok = CreateProcessW(launcher.c_str(), cmdBuf.data(), nullptr, nullptr, TRUE, flags, nullptr,
                           o.shell.c_str(), &si, &pi);
  if (!ok) {
    fprintf(stderr, "[host] CreateProcess 失败：%lu\n", GetLastError());
    return 2;
  }
  SaveRootPid(o, pi.dwProcessId); // 留给 stop 兜底（枚举被裁剪时按这个 pid 整棵树带走）
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);

  fprintf(stdout, "[host] 已拉起 launcher（pid %lu），等它注入 QQ…\n", pi.dwProcessId);

  // 等进程出现 + 二维码出现
  int waited = 0;
  bool sawQr = false;
  while (waited < (waitQrSeconds > 0 ? waitQrSeconds : 3) * 1000) {
    Sleep(500);
    waited += 500;
    pids = OwnPids(o.shell);
    QrInfo qr = ReadQr(o.shell);
    if (qr.exists) sawQr = true;
    if (sawQr && !pids.empty()) break;
  }

  pids = OwnPids(o.shell);
  bool httpUp = PortOpen(o.httpPort);
  QrInfo qr = ReadQr(o.shell);
  fprintf(stdout, "[host] 进程 %zu 个，二维码%s，OneBot %d %s\n", pids.size(),
          qr.exists ? "已生成" : "还没出", o.httpPort, httpUp ? "在线" : "未起");
  WriteStatus(o, pids, httpUp, "started");
  return pids.empty() ? 2 : 0;
}

int RunSupervisor(const Options& o) {
  InitWinsock();
  HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Global\\DSLNapCatHost");
  if (!mutex || GetLastError() == ERROR_ALREADY_EXISTS) {
    fprintf(stderr, "[host] 已经有一个看门狗在跑了\n");
    if (mutex) CloseHandle(mutex);
    return 3;
  }
  fprintf(stdout, "[host] 看门狗启动，shell=%s http=%d 间隔=%ds\n", Narrow(o.shell).c_str(),
          o.httpPort, o.intervalSeconds);
  fflush(stdout);

  int backoff = 0;
  for (;;) {
    std::vector<DWORD> pids = OwnPids(o.shell);
    bool httpUp = PortOpen(o.httpPort);

    if (pids.empty()) {
      // 进程没了：重启（指数退避 3→6→12→24→48→60 秒；连续失败多了退到 10 分钟一轮）
      ++g_fails;
      int delay;
      if (g_fails >= 6) {
        delay = 600;
        g_warning =
            "反复起不来：可能是登录态被写坏（QQ 起来就退出）。删掉登录目录后重新扫码，或直接重置实例。";
      } else if (g_fails >= 3) {
        delay = backoff > 120 ? 120 : backoff;
        g_warning = "连续起不来几次了，还在重试；要是二维码一直不出现，重置一下登录目录。";
      } else {
        delay = backoff == 0 ? 3 : (backoff > 60 ? 60 : backoff);
        g_warning.clear();
      }
      fprintf(stdout, "[host] 进程不在（连续失败 %d 次），%ds 后拉起\n", g_fails, delay);
      fflush(stdout);
      WriteStatus(o, pids, false, "restarting");
      Sleep(delay * 1000);
      Options tmp = o;
      tmp.waitQrSeconds = 0;
      StartOwn(tmp, 2);
      backoff = delay * 2;
      continue;
    }

    if (!httpUp) {
      // 进程在但 OneBot 不在：多半是没登录 / QQ 自己重启丢了钩子，不去杀它，等它登录
      WriteStatus(o, pids, false, "waiting-login");
    } else {
      backoff = 0;
      g_fails = 0;
      g_warning.clear();
      WriteStatus(o, pids, true, "online");
    }
    Sleep(o.intervalSeconds * 1000);
  }
}

void ParseArgs(int argc, wchar_t** argv, Options& o) {
  for (int i = 1; i < argc; ++i) {
    std::wstring a = argv[i];
    auto next = [&](std::wstring& target) {
      if (i + 1 < argc) target = argv[++i];
    };
    if (a == L"--shell") {
      next(o.shell);
    } else if (a == L"--workdir") {
      next(o.workdir);
      o.workdirExplicit = true;
    } else if (a == L"--login") {
      next(o.login);
    } else if (a == L"--http-port") {
      std::wstring v;
      next(v);
      if (!v.empty()) o.httpPort = _wtoi(v.c_str());
    } else if (a == L"--ws-port") {
      std::wstring v;
      next(v);
      if (!v.empty()) o.wsPort = _wtoi(v.c_str());
    } else if (a == L"--webui-port") {
      std::wstring v;
      next(v);
      if (!v.empty()) o.webuiPort = _wtoi(v.c_str());
    } else if (a == L"--status") {
      next(o.statusFile);
    } else if (a == L"--wait-qr") {
      std::wstring v;
      next(v);
      if (!v.empty()) o.waitQrSeconds = _wtoi(v.c_str());
    } else if (a == L"--interval") {
      std::wstring v;
      next(v);
      if (!v.empty()) o.intervalSeconds = _wtoi(v.c_str());
    } else if (a == L"--help" || a == L"-h") {
      o.command = L"help";
    } else if (!a.empty() && a[0] != L'-') {
      o.command = a;
    }
  }
}

void FillDefaults(Options& o) {
  std::wstring base = L"D:\\NapCatDSL";
  if (o.shell.empty()) o.shell = EnvOr(L"DSLNAPCAT_SHELL", JoinPath(base, L"Shell"));
  if (o.workdir.empty()) o.workdir = EnvOr(L"DSLNAPCAT_WORKDIR", JoinPath(base, L"config"));
  // 登录态默认落在宿主程序自己所在目录下（打包后就是 resources\app\napcat\login），
  // 这样整套 QQ 登录文件夹都归 DSL 管，不跟系统里别的 QQ/NapCat 实例共享。
  // 从 out\ 里跑（开发态编译产物）时自动退到上一级的 login。
  if (o.login.empty()) {
    std::wstring exeDir = ExeDir();
    std::wstring up = exeDir.substr(0, exeDir.find_last_of(L"\\/"));
    std::wstring guess = JoinPath(exeDir, L"login");
    if (Lower(exeDir.substr(exeDir.find_last_of(L"\\/") + 1)) == L"out" && !up.empty())
      guess = JoinPath(up, L"login");
    o.login = EnvOr(L"DSLNAPCAT_LOGIN", guess);
  }
  if (o.statusFile.empty())
    o.statusFile = EnvOr(L"DSLNAPCAT_STATUS", JoinPath(ExeDir(), L"state\\host-status.json"));
  while (!o.login.empty() && (o.login.back() == L'\\' || o.login.back() == L'/')) o.login.pop_back();
  // 去掉尾部分隔符，保证前缀比较干净
  while (!o.shell.empty() && (o.shell.back() == L'\\' || o.shell.back() == L'/')) o.shell.pop_back();
}

void PrintHelp() {
  printf(
      "DSLNapCatHost —— DeepSeek Local 的 NapCat 宿主\n"
      "\n"
      "  DSLNapCatHost status          打印状态 JSON（不启动任何东西）\n"
      "  DSLNapCatHost start           拉起本实例（已在跑则退出码 3）\n"
      "  DSLNapCatHost stop            只杀本实例目录下的进程\n"
      "  DSLNapCatHost run             前台看门狗：掉了自动拉起\n"
      "  DSLNapCatHost qr              打印二维码路径与新不新\n"
      "\n"
      "选项：--shell DIR --login DIR --workdir DIR --http-port N --ws-port N --webui-port N\n"
      "      --status FILE --wait-qr 秒 --interval 秒\n"
      "\n"
      "  --login 是 QQ 自己的登录态目录（默认 <宿主目录>\\login）。\n"
      "  不指定它的话 QQ 会读系统共享 profile，直接登录成别的号、不出二维码。\n");
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Options o;
  ParseArgs(argc, argv, o);
  FillDefaults(o);

  if (o.command == L"help" || o.command == L"--help") {
    PrintHelp();
    return 0;
  }
  if (o.command == L"status") {
    InitWinsock();
    // status 是只读查询：先把状态文件里看门狗持久化的 fails/warning 读回来（否则永远是 0，
    // 上层的自动纠错就看不见「反复起不来」这件事），也不要回写状态文件（回写会把它的计数清成 0）。
    LoadPersistedStatus(o);
    std::vector<DWORD> pids = OwnPids(o.shell);
    bool httpUp = PortOpen(o.httpPort);
    std::string json = BuildStatusJson(o, pids, httpUp, "status");
    fwrite(json.data(), 1, json.size(), stdout);
    return 0;
  }
  if (o.command == L"stop") {
    int killed = StopOwn(o);
    fprintf(stdout, "[host] 已停止 %d 个进程\n", killed);
    WriteStatus(o, OwnPids(o.shell), false, "stopped");
    return 0;
  }
  if (o.command == L"start") {
    int rc = StartOwn(o, o.waitQrSeconds);
    return rc;
  }
  if (o.command == L"run") {
    return RunSupervisor(o);
  }
  if (o.command == L"qr") {
    QrInfo qr = ReadQr(o.shell);
    printf("{\"exists\":%s,\"path\":\"%s\",\"size\":%llu,\"mtime\":%lld}\n",
           qr.exists ? "true" : "false", JsonEscape(Narrow(qr.path)).c_str(), qr.size, qr.mtime);
    return 0;
  }
  fprintf(stderr, "[host] 不认识的命令：%s（用 --help 看用法）\n", Narrow(o.command).c_str());
  return 1;
}
