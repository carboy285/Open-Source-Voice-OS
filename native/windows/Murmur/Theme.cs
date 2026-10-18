using System;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shell;
using Microsoft.Win32;

namespace Murmur
{
    /// <summary>System appearance and accessibility settings, read live.</summary>
    internal static class Theme
    {
        private static object? Personalize(string name) =>
            Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", name, null);

        public static bool IsDark => Personalize("AppsUseLightTheme") is int light && light == 0;
        public static bool HighContrast => SystemParameters.HighContrast;
        /// <summary>Windows "Animation effects" off means Reduce Motion.</summary>
        public static bool ReduceMotion => !SystemParameters.ClientAreaAnimation;
        /// <summary>Windows "Transparency effects" off means solid backgrounds.</summary>
        public static bool ReduceTransparency => HighContrast || (Personalize("EnableTransparency") is int on && on == 0);

        /// <summary>Settings › Accessibility › Text size, 1.0 to 2.25.</summary>
        public static double TextScale =>
            Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Accessibility", "TextScaleFactor", 100) is int f ? Math.Clamp(f / 100.0, 1, 2.25) : 1;

        public static readonly FontFamily Font = new("Segoe UI Variable Text, Segoe UI");
        public static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");

        public static double Body => 14 * TextScale;
        public static double Caption => 12 * TextScale;
        public static double Subtitle => 16 * TextScale;
        public static double Title => 20 * TextScale;

        public static Brush Text => HighContrast ? SystemColors.WindowTextBrush : Solid(IsDark ? 0xFFFFFFFF : 0xE4000000);
        public static Brush Secondary => HighContrast ? SystemColors.GrayTextBrush : Solid(IsDark ? 0xC5FFFFFF : 0x9E000000);
        public static Brush Surface => HighContrast ? SystemColors.WindowBrush : Solid(IsDark ? 0xFF2B2B2B : 0xFFF9F9F9);
        public static Brush Subtle => Solid(IsDark ? 0x15FFFFFFu : 0x0A000000u);
        public static Brush Stroke => Solid(IsDark ? 0x1FFFFFFFu : 0x14000000u);
        public static Brush Destructive => Solid(0xFFC42B1C);
        public static Brush Warning => Solid(IsDark ? 0xFFFCE100 : 0xFF9D5D00);
        public static Brush Success => Solid(IsDark ? 0xFF6CCB5F : 0xFF0F7B0F);

        public static Brush Accent
        {
            get
            {
                if (HighContrast) return SystemColors.HighlightBrush;
                var value = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\DWM", "AccentColor", null);
                if (value is int abgr)
                {
                    var c = unchecked((uint)abgr);
                    return new SolidColorBrush(Color.FromRgb((byte)(c & 0xFF), (byte)((c >> 8) & 0xFF), (byte)((c >> 16) & 0xFF)));
                }
                return Solid(0xFF4B3FA8);
            }
        }

        public static SolidColorBrush Solid(uint argb)
        {
            var brush = new SolidColorBrush(Color.FromArgb((byte)(argb >> 24), (byte)(argb >> 16), (byte)(argb >> 8), (byte)argb));
            brush.Freeze();
            return brush;
        }
    }

    /// <summary>Mica or Acrylic through DWM on Windows 11 22H2+, with a solid fallback.</summary>
    internal static class Backdrop
    {
        public static bool Supported => Environment.OSVersion.Version.Build >= 22621 && !Theme.ReduceTransparency;

        /// <summary>Call before the window is shown. Transient surfaces (indicator, popovers) use Acrylic, the panel uses Mica.</summary>
        public static void Apply(Window window, bool transient, Brush? fallback = null, bool caption = false)
        {
            if (!Supported)
            {
                window.Background = fallback ?? Theme.Surface;
                return;
            }
            window.Background = Brushes.Transparent;
            WindowChrome.SetWindowChrome(window, new WindowChrome
            {
                CaptionHeight = caption ? 32 : 0,
                GlassFrameThickness = new Thickness(-1),
                ResizeBorderThickness = new Thickness(caption ? 4 : 0),
                UseAeroCaptionButtons = caption,
                CornerRadius = new CornerRadius(8),
            });
            window.SourceInitialized += (_, _) =>
            {
                var hwnd = new WindowInteropHelper(window).Handle;
                var margins = new Native.MARGINS { Left = -1, Right = -1, Top = -1, Bottom = -1 };
                Native.DwmExtendFrameIntoClientArea(hwnd, ref margins);
                var dark = Theme.IsDark ? 1 : 0;
                Native.DwmSetWindowAttribute(hwnd, Native.DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
                var corner = Native.DWMWCP_ROUND;
                Native.DwmSetWindowAttribute(hwnd, Native.DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int));
                var kind = transient ? Native.DWMSBT_TRANSIENTWINDOW : Native.DWMSBT_MAINWINDOW;
                Native.DwmSetWindowAttribute(hwnd, Native.DWMWA_SYSTEMBACKDROP_TYPE, ref kind, sizeof(int));
            };
        }

        /// <summary>Keeps a tool window out of Alt+Tab and stops it from taking focus.</summary>
        public static void NoActivate(Window window)
        {
            window.SourceInitialized += (_, _) =>
            {
                var hwnd = new WindowInteropHelper(window).Handle;
                var style = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
                Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, style | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW);
            };
        }
    }

    /// <summary>
    /// Settles like a critically damped spring: fast start, no overshoot. Used in place of fixed-duration curves.
    /// </summary>
    internal sealed class CriticallyDampedEase : EasingFunctionBase
    {
        public double Stiffness { get; set; } = 7;

        public CriticallyDampedEase()
        {
            EasingMode = EasingMode.EaseIn;
        }

        protected override double EaseInCore(double t)
        {
            var w = Stiffness;
            var end = 1 - (1 + w) * Math.Exp(-w);
            return (1 - (1 + w * t) * Math.Exp(-w * t)) / end;
        }

        protected override Freezable CreateInstanceCore() => new CriticallyDampedEase { Stiffness = Stiffness };
    }

    /// <summary>
    /// Every animation starts from the current on-screen value (no From) and replaces any running one,
    /// so a panel can be reopened mid-flight without jumping and input is never locked.
    /// </summary>
    internal static class Motion
    {
        public static void To(IAnimatable target, DependencyProperty property, double value, double ms = 350, Action? done = null)
        {
            if (Theme.ReduceMotion && property != UIElement.OpacityProperty)
            {
                target.BeginAnimation(property, null);
                if (target is DependencyObject d) d.SetValue(property, value);
                done?.Invoke();
                return;
            }
            var animation = new DoubleAnimation(value, TimeSpan.FromMilliseconds(Theme.ReduceMotion ? 180 : ms))
            {
                EasingFunction = Theme.ReduceMotion ? new QuadraticEase { EasingMode = EasingMode.EaseInOut } : new CriticallyDampedEase(),
                FillBehavior = FillBehavior.HoldEnd,
            };
            if (done != null) animation.Completed += (_, _) => done();
            target.BeginAnimation(property, animation, HandoffBehavior.SnapshotAndReplace);
        }

        /// <summary>Appear: fade plus a small scale from the origin point. Under Reduce Motion, a cross-fade only.</summary>
        public static void Pop(FrameworkElement element, bool show, Point origin, Action? done = null)
        {
            if (element.RenderTransform is not ScaleTransform scale)
            {
                scale = new ScaleTransform(1, 1);
                element.RenderTransform = scale;
            }
            element.RenderTransformOrigin = origin;
            To(element, UIElement.OpacityProperty, show ? 1 : 0, 300, done);
            if (!Theme.ReduceMotion)
            {
                To(scale, ScaleTransform.ScaleXProperty, show ? 1 : 0.9, 350);
                To(scale, ScaleTransform.ScaleYProperty, show ? 1 : 0.9, 350);
            }
        }
    }
}
