using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

// Reports only whether the desktop or our own widget is active. No titles,
// account data, or information about other applications leaves this process.
public static class LimitTrackDesktop {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);

    static bool IsDesktopOrWidget(IntPtr widget) {
        IntPtr foreground = GetForegroundWindow();
        if (foreground == widget) return true;
        var name = new StringBuilder(256);
        GetClassName(foreground, name, name.Capacity);
        return name.ToString() == "Progman" || name.ToString() == "WorkerW";
    }

    public static int Main(string[] args) {
        long value;
        if (args.Length != 1 || !Int64.TryParse(args[0], out value)) return 1;
        var widget = new IntPtr(value);
        string previous = "";
        DateTime lastReport = DateTime.MinValue;
        while (IsWindow(widget)) {
            string state = IsDesktopOrWidget(widget) ? "desktop" : "other";
            if (state != previous || (DateTime.UtcNow - lastReport).TotalSeconds >= 1) {
                Console.WriteLine(state);
                Console.Out.Flush();
                previous = state;
                lastReport = DateTime.UtcNow;
            }
            Thread.Sleep(200);
        }
        return 0;
    }
}
