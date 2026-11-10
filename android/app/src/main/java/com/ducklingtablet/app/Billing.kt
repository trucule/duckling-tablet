package com.ducklingtablet.app

import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * The subscription through Google Play (Play Billing). Every purchase carries the family's appAccountToken as the
 * obfuscated account id, and every purchase token goes to the API (POST /billing/google/link), which checks it with
 * Google, records it for the family and acknowledges it. Renewals, failed payments and refunds reach the API from
 * Google directly afterwards. Results go to the web app as DucklingWeb.onBilling(status, message).
 */
class Billing(private val activity: MainActivity, private val report: (String, String) -> Unit, private val changed: () -> Unit) {
    companion object { const val PRODUCT = "duckling_monthly"; const val API = "https://api.ducklingtablet.com" }

    private val prefs = Prefs(activity)
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var details: ProductDetails? = null
    /** The store's price for the subscription in the parent's own currency, shown on the subscribe button. */
    @Volatile var displayPrice = ""
        private set

    private val updated = PurchasesUpdatedListener { result, purchases ->
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> io.execute {
                val list = purchases.orEmpty()
                val done = list.any { it.purchaseState == Purchase.PurchaseState.PURCHASED && link(it) }
                val pending = list.any { it.purchaseState == Purchase.PurchaseState.PENDING }
                when {
                    done -> report("purchased", "")
                    pending -> report("pending", "The purchase is waiting for payment.")
                    else -> report("failed", "The purchase could not be confirmed. Try Restore purchases in a minute.")
                }
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> report("cancelled", "")
            BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> restore()
            else -> report("failed", result.debugMessage)
        }
    }

    private val client: BillingClient = BillingClient.newBuilder(activity)
        .setListener(updated)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()

    /** Connects, loads the price, and sends the tablet's current purchases to the API (one made while it was offline,
     *  or acknowledged here because the API was down, reaches the family this way). */
    fun start() {
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                if (result.responseCode != BillingClient.BillingResponseCode.OK) return
                loadDetails {}
                owned { list -> io.execute { list.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }.forEach { link(it) } } }
            }
            override fun onBillingServiceDisconnected() {}
        })
    }

    private fun loadDetails(then: (ProductDetails?) -> Unit) {
        details?.let { return then(it) }
        val params = QueryProductDetailsParams.newBuilder().setProductList(listOf(
            QueryProductDetailsParams.Product.newBuilder().setProductId(PRODUCT).setProductType(BillingClient.ProductType.SUBS).build(),
        )).build()
        client.queryProductDetailsAsync(params) { result, found ->
            val d = if (result.responseCode == BillingClient.BillingResponseCode.OK) found.productDetailsList.firstOrNull() else null
            if (d != null) {
                details = d
                displayPrice = baseOffer(d)?.pricingPhases?.pricingPhaseList?.lastOrNull()?.formattedPrice ?: ""
                main.post { changed() }
            }
            then(d)
        }
    }

    /** The plain monthly plan: the offer without an offer id (special offers, when there are any, carry one). */
    private fun baseOffer(d: ProductDetails) = d.subscriptionOfferDetails?.let { offers -> offers.firstOrNull { it.offerId == null } ?: offers.firstOrNull() }

    fun subscribe() {
        val account = prefs.appAccountToken
        if (account.isEmpty()) return report("unavailable", "Connect this tablet to the internet and try again.")
        loadDetails { d ->
            val offer = d?.let { baseOffer(it) }
            if (d == null || offer == null) return@loadDetails report("unavailable", "The subscription is not available right now.")
            val flow = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(d).setOfferToken(offer.offerToken).build()))
                .setObfuscatedAccountId(account)
                .build()
            main.post {
                // Google Play's purchase sheet is another app's screen, which a pinned task cannot show; the lockdown
                // comes back in onResume.
                activity.unpin()
                val r = client.launchBillingFlow(activity, flow)
                if (r.responseCode != BillingClient.BillingResponseCode.OK) report("failed", r.debugMessage)
            }
        }
    }

    fun restore() {
        owned { list ->
            io.execute {
                val active = list.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
                if (active.isEmpty()) report("none", "No subscription was found for the Google account on this tablet.")
                else report(if (active.map { link(it) }.any { it }) "purchased" else "failed", "")
            }
        }
    }

    fun manage() {
        main.post {
            activity.unpin()
            try { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/account/subscriptions?sku=$PRODUCT&package=${activity.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
        }
    }

    private fun owned(then: (List<Purchase>) -> Unit) {
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { result, list ->
            then(if (result.responseCode == BillingClient.BillingResponseCode.OK) list else emptyList())
        }
    }

    /**
     * Tells the API about a purchase (it acknowledges it with Google). If the API cannot be reached, the purchase is
     * acknowledged here, since Google refunds one left unacknowledged for three days; the next start sends it again.
     * 409: the subscription belongs to another family, which is not ours to link.
     */
    private fun link(p: Purchase): Boolean {
        val token = prefs.deviceToken
        val ok = token.isNotEmpty() && try {
            val c = URL("$API/billing/google/link").openConnection() as HttpURLConnection
            c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 15000; c.readTimeout = 20000
            c.setRequestProperty("Content-Type", "application/json")
            c.setRequestProperty("Authorization", "Device $token")
            c.outputStream.use { it.write(JSONObject().put("purchaseToken", p.purchaseToken).put("productId", p.products.firstOrNull() ?: PRODUCT).toString().toByteArray()) }
            val code = c.responseCode
            c.disconnect()
            code == 200 || code == 409
        } catch (_: Exception) { false }
        if (!ok && !p.isAcknowledged) client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.purchaseToken).build()) {}
        return ok
    }
}
