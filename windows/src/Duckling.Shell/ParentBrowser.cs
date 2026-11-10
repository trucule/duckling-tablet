using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Duckling.Shell;

/// <summary>A browser window for a parent, opened only from the parent area: Stripe Checkout and the Customer Portal,
/// or a Wi-Fi network's sign-in page. It reaches any site (card checks and banks use their own), and it closes by
/// itself when Stripe returns to ducklingtablet.com/checkout/.</summary>
public class ParentBrowser : Form
{
    readonly MainForm main;
    readonly string url;
    readonly WebView2 web = new() { Dock = DockStyle.Fill };
    public event Action<string, string>? Done;
    bool reported;

    public ParentBrowser(MainForm main, string url)
    {
        this.main = main; this.url = url;
        Text = "Duckling Tablet: parent";
        Icon = main.Icon;
        StartPosition = FormStartPosition.CenterScreen;
        WindowState = FormWindowState.Maximized;
        TopMost = main.ChildSession;
        ShowInTaskbar = false;
        Controls.Add(web);
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        try
        {
            await web.EnsureCoreWebView2Async(main.Env);
            var core = web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.NewWindowRequested += (_, ev) => { ev.Handled = true; core.Navigate(ev.Uri); };
            core.DownloadStarting += (_, ev) => ev.Cancel = true;
            core.NavigationStarting += (_, ev) =>
            {
                if (!Uri.TryCreate(ev.Uri, UriKind.Absolute, out var u)) { ev.Cancel = true; return; }
                if (u.Scheme is not ("https" or "http" or "about")) { ev.Cancel = true; return; }
                if (u.Host == new Uri(Paths.Site).Host && u.AbsolutePath.StartsWith("/checkout/", StringComparison.OrdinalIgnoreCase))
                {
                    var how = u.AbsolutePath.Contains("success") ? "purchased" : u.AbsolutePath.Contains("cancel") ? "cancelled" : "returned";
                    Finish(how, ev.Uri);
                    ev.Cancel = true;
                    BeginInvoke(Close);
                }
            };
            core.Navigate(url);
        }
        catch (Exception ex) { ShellLog.Write($"parent page: {ex.Message}"); Finish("closed", ""); Close(); }
    }

    void Finish(string how, string final) { if (reported) return; reported = true; Done?.Invoke(how, final); }

    protected override void OnFormClosed(FormClosedEventArgs e) { Finish("closed", ""); web.Dispose(); base.OnFormClosed(e); }
}
