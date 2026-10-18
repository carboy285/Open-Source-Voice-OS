using System;
using System.Threading;
using System.Windows;

namespace Murmur
{
    public static class Program
    {
        [STAThread]
        public static int Main()
        {
            using var single = new Mutex(true, @"Local\Murmur.Shell", out var first);
            if (!first) return 0;
            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            app.Startup += (_, _) =>
            {
                var controller = new AppController(app.Dispatcher);
                controller.Start();
            };
            return app.Run();
        }
    }
}
