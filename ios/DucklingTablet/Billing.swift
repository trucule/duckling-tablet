import Foundation
import StoreKit
import UIKit

/// The subscription through the App Store (StoreKit 2). Every purchase carries the family's appAccountToken from the
/// device config, and every verified transaction goes to the API (POST /billing/apple/link), which records it for
/// the family. Renewals, failed payments and refunds reach the API directly from Apple afterwards.
final class Billing {
    static let shared = Billing()
    static let productId = "duckling_monthly"
    private var updates: Task<Void, Never>?
    /// The App Store's price for the subscription in the parent's own currency, shown on the subscribe button.
    private(set) var displayPrice = ""
    var onChange: (() -> Void)?

    func listen() {
        updates = Task.detached(priority: .background) {
            for await result in Transaction.updates { await Billing.shared.handle(result) }
        }
        Task {
            let products = (try? await Product.products(for: [Self.productId])) ?? []
            if let p = products.first { await MainActor.run { self.displayPrice = p.displayPrice; self.onChange?() } }
        }
    }

    /// Returns a status for the web app ("purchased", "pending", "cancelled", "unavailable", "failed") and a message.
    func subscribe() async -> (String, String) {
        guard let token = UUID(uuidString: Prefs.shared.appAccountToken) else { return ("unavailable", "Connect this iPad to the internet and try again.") }
        let products = (try? await Product.products(for: [Self.productId])) ?? []
        guard let product = products.first else { return ("unavailable", "The subscription is not available right now.") }
        do {
            switch try await product.purchase(options: [.appAccountToken(token)]) {
            case .success(let result):
                await handle(result)
                return ("purchased", "")
            case .userCancelled: return ("cancelled", "")
            case .pending: return ("pending", "The purchase is waiting for approval.")
            @unknown default: return ("failed", "")
            }
        } catch {
            return ("failed", error.localizedDescription)
        }
    }

    func restore() async -> (String, String) {
        do { try await AppStore.sync() } catch { return ("failed", error.localizedDescription) }
        var any = false
        for await result in Transaction.currentEntitlements { any = true; await handle(result) }
        return any ? ("purchased", "") : ("none", "No subscription was found for this Apple ID.")
    }

    @MainActor func manage() async {
        guard let scene = UIApplication.shared.connectedScenes.first(where: { $0 is UIWindowScene }) as? UIWindowScene else { return }
        try? await AppStore.showManageSubscriptions(in: scene)
    }

    func handle(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = result else { return }
        if await link(result.jwsRepresentation) { await transaction.finish() }
    }

    /// Tells the API about the transaction. Unfinished transactions come back through Transaction.updates, so one
    /// that fails to reach the API here is sent again later.
    private func link(_ jws: String) async -> Bool {
        let token = Prefs.shared.deviceToken
        guard !token.isEmpty, let url = URL(string: "https://api.ducklingtablet.com/billing/apple/link") else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Device \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["signedTransaction": jws])
        guard let (_, response) = try? await URLSession.shared.data(for: req), let http = response as? HTTPURLResponse else { return false }
        // 409: the subscription belongs to another family; finishing it here is right, it is not ours to link.
        return http.statusCode == 200 || http.statusCode == 409
    }
}
