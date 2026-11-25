import AuthenticationServices
import CryptoKit
import UIKit

/// Continue with Apple during setup: the iPad's own Apple Account sheet, then Apple's ID token for the server to
/// check. The request carries the SHA-256 of the server's nonce, which Apple copies into the token, so a token cannot
/// be replayed. done(status, idToken, message): status is "ok", "cancelled" or "failed"; the message is empty, and
/// the web app shows its own sentence.
final class AppleSignIn: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var done: ((String, String, String) -> Void)?
    private weak var window: UIWindow?

    func start(nonce: String, window: UIWindow?, done: @escaping (String, String, String) -> Void) {
        self.done?("cancelled", "", "")
        self.done = done
        self.window = window
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.email]
        request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    private func finish(_ status: String, _ token: String) {
        let d = done
        done = nil
        d?(status, token, "")
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let c = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = c.identityToken, let token = String(data: data, encoding: .utf8) else { return finish("failed", "") }
        finish("ok", token)
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        finish((error as? ASAuthorizationError)?.code == .canceled ? "cancelled" : "failed", "")
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        window ?? UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? UIWindow()
    }
}
