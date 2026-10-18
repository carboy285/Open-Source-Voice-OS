import { execFile } from "node:child_process";
import type { SecretStore } from "./store.js";

const SERVICE = "Murmur";

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

const quote = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;

const WINDOWS_CRED = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MurmurCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.Persist = 2; c.UserName = "Murmur";
    c.CredentialBlobSize = bytes.Length; c.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
    Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
    try { if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
  public static void Delete(string target) { CredDeleteW(target, 1, 0); }
}
"@
`;

/**
 * Keychain access for the CLI, which runs without a shell: macOS `security`,
 * Linux `secret-tool` (libsecret), Windows Credential Manager through PowerShell.
 * Secret values go through stdin, never through the command line.
 */
export class OsKeychainStore implements SecretStore {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async get(key: string): Promise<string | undefined> {
    if (this.platform === "darwin") {
      const r = await run("security", ["find-generic-password", "-s", SERVICE, "-a", key, "-w"]);
      return r.code === 0 ? r.stdout.replace(/\n$/, "") : undefined;
    }
    if (this.platform === "win32") {
      const r = await this.powershell(
        `$v = [MurmurCred]::Read(${psQuote(target(key))}); if ($v -ne $null) { [Console]::Out.Write($v) }`,
      );
      return r.code === 0 && r.stdout ? r.stdout : undefined;
    }
    const r = await run("secret-tool", ["lookup", "service", SERVICE, "account", key]);
    return r.code === 0 && r.stdout ? r.stdout.replace(/\n$/, "") : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    let r;
    if (this.platform === "darwin") {
      r = await run(
        "security",
        ["-i"],
        `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(key)} -w ${quote(value)}\n`,
      );
    } else if (this.platform === "win32") {
      r = await this.powershell(`[MurmurCred]::Write(${psQuote(target(key))}, [Console]::In.ReadToEnd())`, value);
    } else {
      r = await run("secret-tool", ["store", `--label=${SERVICE} ${key}`, "service", SERVICE, "account", key], value);
    }
    if (r.code !== 0) throw new Error(`Could not save to the keychain: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  async delete(key: string): Promise<void> {
    if (this.platform === "darwin") await run("security", ["delete-generic-password", "-s", SERVICE, "-a", key]);
    else if (this.platform === "win32") await this.powershell(`[MurmurCred]::Delete(${psQuote(target(key))})`);
    else await run("secret-tool", ["clear", "service", SERVICE, "account", key]);
  }

  private powershell(script: string, input?: string) {
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${WINDOWS_CRED}\n${script}`], input);
  }
}

const target = (key: string) => `${SERVICE}/${key}`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
