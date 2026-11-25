using Microsoft.Identity.Client;
using Microsoft.Identity.Client.Broker;

namespace Duckling.Shell;

/// <summary>Continue with Microsoft during setup: Windows' own account broker (WAM) offers the Microsoft account
/// already signed in to this PC, and the web app gets its ID token for the server to check. Personal accounts only
/// (the consumers authority), the same app registration as the portal. The broker sets its own nonce; the server
/// checks the token's issuer, audience and times.</summary>
static class MicrosoftSignIn
{
    // The email scope puts the account's address in the ID token; User.Read is the plain Microsoft Graph sign-in
    // permission every registration has, so the request asks the parent for nothing more.
    static readonly string[] Scopes = { "User.Read", "email" };

    /// <summary>Returns ("ok", idToken), ("cancelled", "") or ("failed", ""). Runs on the UI thread, which the
    /// broker's window needs.</summary>
    public static async Task<(string Status, string Token)> Run(IntPtr window, string clientId)
    {
        try
        {
            var app = PublicClientApplicationBuilder.Create(clientId)
                .WithAuthority("https://login.microsoftonline.com/consumers")
                .WithDefaultRedirectUri()
                .WithParentActivityOrWindow(() => window)
                .WithBroker(new BrokerOptions(BrokerOptions.OperatingSystems.Windows) { Title = "Duckling Tablet" })
                .Build();
            var r = await app.AcquireTokenInteractive(Scopes).WithPrompt(Prompt.SelectAccount).ExecuteAsync();
            return string.IsNullOrEmpty(r.IdToken) ? ("failed", "") : ("ok", r.IdToken);
        }
        catch (MsalClientException e) when (e.ErrorCode == MsalError.AuthenticationCanceledError)
        {
            return ("cancelled", "");
        }
        catch (Exception e)
        {
            ShellLog.Write($"microsoft sign-in: {e.GetType().Name}");
            return ("failed", "");
        }
    }
}
