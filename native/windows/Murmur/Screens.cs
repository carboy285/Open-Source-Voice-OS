using System.Windows;
using System.Windows.Media;

namespace Murmur
{
    /// <summary>The work area of the monitor under the pointer, in WPF device-independent units.</summary>
    internal static class Screens
    {
        public static Rect WorkAreaAtPointer(Visual? reference = null) => ToDips(System.Windows.Forms.Screen.FromPoint(System.Windows.Forms.Cursor.Position).WorkingArea, reference);

        public static Rect BoundsAtPointer(Visual? reference = null) => ToDips(System.Windows.Forms.Screen.FromPoint(System.Windows.Forms.Cursor.Position).Bounds, reference);

        private static Rect ToDips(System.Drawing.Rectangle area, Visual? reference)
        {
            var scale = reference != null && PresentationSource.FromVisual(reference) != null ? VisualTreeHelper.GetDpi(reference).DpiScaleX : SystemDpi;
            return new Rect(area.Left / scale, area.Top / scale, area.Width / scale, area.Height / scale);
        }

        private static double SystemDpi
        {
            get
            {
                using var g = System.Drawing.Graphics.FromHwnd(System.IntPtr.Zero);
                return g.DpiX / 96.0;
            }
        }
    }
}
