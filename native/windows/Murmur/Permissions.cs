using System;
using System.Diagnostics;
using Microsoft.Win32;

namespace Murmur
{
    /// <summary>Microphone privacy status, launch at login, and the matching Settings pages.</summary>
    internal static class Permissions
    {
        public const string AppKey = @"HKEY_CURRENT_USER\Software\Murmur";
        private const string Consent = @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        /// <summary>Both the global switch and the desktop-apps switch must allow the microphone.</summary>
        public static bool MicrophoneAllowed =>
            !string.Equals(Registry.GetValue(Consent, "Value", "Allow") as string, "Deny", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(Registry.GetValue(Consent + @"\NonPackaged", "Value", "Allow") as string, "Deny", StringComparison.OrdinalIgnoreCase);

        public static void OpenMicrophoneSettings() => Process.Start(new ProcessStartInfo("ms-settings:privacy-microphone") { UseShellExecute = true });

        public static bool LaunchAtLogin
        {
            get
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunKey);
                return key?.GetValue("Murmur") != null;
            }
            set
            {
                using var key = Registry.CurrentUser.CreateSubKey(RunKey);
                if (value) key.SetValue("Murmur", "\"" + Environment.ProcessPath + "\"");
                else key.DeleteValue("Murmur", false);
            }
        }
    }
}
