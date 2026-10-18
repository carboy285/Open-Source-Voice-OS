using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Murmur
{
    /// <summary>
    /// Modifier-only hotkey (Right Alt by default) through a low-level keyboard hook.
    /// Down fires on press so the indicator appears before release.
    /// </summary>
    public sealed class HotkeyMonitor : IDisposable
    {
        public int KeyCode = Native.VK_RMENU;
        public bool ToggleMode;
        public event Action<HotkeyAction>? Down;
        public event Action? Up;
        public event Action? Escape;

        private readonly Native.LowLevelKeyboardProc proc;
        private IntPtr hook = IntPtr.Zero;
        private bool isDown;
        private bool shiftDown, ctrlDown, keyHeld;

        public HotkeyMonitor()
        {
            proc = Callback;
        }

        public bool Start()
        {
            if (hook != IntPtr.Zero) return true;
            using var module = Process.GetCurrentProcess().MainModule;
            hook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, proc, Native.GetModuleHandle(module?.ModuleName), 0);
            return hook != IntPtr.Zero;
        }

        public void Dispose()
        {
            if (hook != IntPtr.Zero) Native.UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
        }

        public static string Name(int keyCode) => keyCode switch
        {
            Native.VK_RMENU => "Right Alt",
            Native.VK_RCONTROL => "Right Ctrl",
            _ => "Key " + keyCode,
        };

        private IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                var data = Marshal.PtrToStructure<Native.KBDLLHOOKSTRUCT>(lParam);
                var message = wParam.ToInt32();
                var down = message == Native.WM_KEYDOWN || message == Native.WM_SYSKEYDOWN;
                var up = message == Native.WM_KEYUP || message == Native.WM_SYSKEYUP;
                var vk = (int)data.vkCode;
                // AltGr sends a synthetic Left Ctrl with scan code 0x21D; it is not a real Ctrl press.
                var fakeCtrl = vk == Native.VK_LCONTROL && (data.scanCode & 0x200) != 0;

                if (vk == Native.VK_LSHIFT || vk == Native.VK_RSHIFT || vk == Native.VK_SHIFT) shiftDown = down || (!up && shiftDown);
                if ((vk == Native.VK_LCONTROL || vk == Native.VK_RCONTROL) && !fakeCtrl) ctrlDown = down || (!up && ctrlDown);

                if (vk == Native.VK_ESCAPE && down && isDown)
                {
                    isDown = false;
                    Escape?.Invoke();
                }
                else if (vk == KeyCode)
                {
                    var action = shiftDown ? HotkeyAction.Agent : ctrlDown ? HotkeyAction.Edit : HotkeyAction.Dictate;
                    if (!ToggleMode)
                    {
                        if (down && !isDown)
                        {
                            isDown = true;
                            SuppressMenuActivation();
                            Down?.Invoke(action);
                        }
                        else if (up && isDown)
                        {
                            isDown = false;
                            Up?.Invoke();
                        }
                    }
                    else if (down && !keyHeld)
                    {
                        keyHeld = true;
                        SuppressMenuActivation();
                        isDown = !isDown;
                        if (isDown) Down?.Invoke(action);
                        else Up?.Invoke();
                    }
                    else if (up)
                    {
                        keyHeld = false;
                    }
                }
            }
            return Native.CallNextHookEx(hook, nCode, wParam, lParam);
        }

        /// <summary>A lone Alt press and release focuses the menu bar in many apps; an unassigned key press while Alt is held prevents that.</summary>
        private static void SuppressMenuActivation()
        {
            Native.Send(Native.Key(0xE8, false), Native.Key(0xE8, true));
        }
    }
}
