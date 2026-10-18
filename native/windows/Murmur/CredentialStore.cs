using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Murmur
{
    /// <summary>Windows Credential Manager, target "Murmur/&lt;key&gt;". The CLI uses the same layout.</summary>
    internal static class CredentialStore
    {
        private const int CRED_TYPE_GENERIC = 1, CRED_PERSIST_LOCAL_MACHINE = 2;
        private static string Target(string key) => "Murmur/" + key;

        public static string? Get(string key)
        {
            if (!Native.CredReadW(Target(key), CRED_TYPE_GENERIC, 0, out var pointer)) return null;
            try
            {
                var credential = Marshal.PtrToStructure<Native.CREDENTIAL>(pointer);
                return credential.CredentialBlobSize == 0
                    ? string.Empty
                    : Marshal.PtrToStringUni(credential.CredentialBlob, credential.CredentialBlobSize / 2);
            }
            finally
            {
                Native.CredFree(pointer);
            }
        }

        public static bool Set(string key, string value)
        {
            var bytes = Encoding.Unicode.GetBytes(value);
            var credential = new Native.CREDENTIAL
            {
                Type = CRED_TYPE_GENERIC,
                TargetName = Target(key),
                Persist = CRED_PERSIST_LOCAL_MACHINE,
                UserName = "Murmur",
                CredentialBlobSize = bytes.Length,
                CredentialBlob = Marshal.AllocHGlobal(Math.Max(bytes.Length, 1)),
            };
            try
            {
                Marshal.Copy(bytes, 0, credential.CredentialBlob, bytes.Length);
                return Native.CredWriteW(ref credential, 0);
            }
            finally
            {
                Marshal.FreeHGlobal(credential.CredentialBlob);
            }
        }

        public static void Delete(string key) => Native.CredDeleteW(Target(key), CRED_TYPE_GENERIC, 0);
    }
}
