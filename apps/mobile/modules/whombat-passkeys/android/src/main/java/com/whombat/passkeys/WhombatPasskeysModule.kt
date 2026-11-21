package com.whombat.passkeys

import android.os.Build
import android.os.CancellationSignal
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.SignalAllAcceptedCredentialIdsRequest
import androidx.credentials.SignalCredentialStateRequest
import androidx.credentials.SignalCredentialStateResponse
import androidx.credentials.SignalUnknownCredentialRequest
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException
import androidx.credentials.exceptions.CreateCredentialUnsupportedException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.domerrors.NotAllowedError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.SignalCredentialStateException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

/**
 * `WhombatPasskeys` (Android): WebAuthn through Credential Manager, JSON in and JSON out — the request is the WebAuthn
 * options JSON control sends (`PublicKeyCredentialCreationOptionsJSON` / `…RequestOptionsJSON`), the answer the
 * `RegistrationResponseJSON` / `AuthenticationResponseJSON` the Whombat and control verify. The origin is the app's
 * `android:apk-key-hash:…`, which both accept (PK-02); the RP ID is the hosted UI's host, which the UI's
 * `/.well-known/assetlinks.json` ties to this app (`get_login_creds`). The JavaScript side is
 * `modules/whombat-passkeys/index.ts`.
 *
 * Rejections carry a code the app tells apart: `cancelled` (dismissed, or not allowed), `exists` (this provider already
 * holds a passkey for the Whombat), `none` (no passkey for it on this phone), `unsupported` (no provider), `failed`.
 *
 * `forget` and `keepOnly` pass WebAuthn's Signal API requests on (`{rpId, credentialId}`, `{rpId, userId,
 * allAcceptedCredentialIds}`), so the passkey provider stops offering passkeys whose Whombat is gone. They show nothing
 * and always resolve: a provider that can't is no reason to tell the person anything.
 */
class WhombatPasskeysModule : Module() {
  private val executor = Executors.newSingleThreadExecutor()

  override fun definition() = ModuleDefinition {
    Name("WhombatPasskeys")

    /** Credential Manager offers passkeys from Android 9 (API 28) with Google Play services. */
    Function("isSupported") { Build.VERSION.SDK_INT >= 28 }

    /**
     * WebAuthn's PRF extension (it locks the recovery kit): `get` hands the request JSON, `extensions.prf` included, to
     * Credential Manager as it is, and the provider's answer carries `clientExtensionResults.prf` when it offers PRF.
     */
    Function("supportsPrf") { Build.VERSION.SDK_INT >= 28 }

    AsyncFunction("create") { requestJson: String, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("failed", "No activity to show the passkey prompt on.", null)
        return@AsyncFunction
      }
      val manager = CredentialManager.create(activity)
      manager.createCredentialAsync(
        activity,
        CreatePublicKeyCredentialRequest(requestJson),
        CancellationSignal(),
        executor,
        object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
          override fun onResult(result: CreateCredentialResponse) {
            if (result is CreatePublicKeyCredentialResponse) promise.resolve(result.registrationResponseJson)
            else promise.reject("failed", "Not a passkey.", null)
          }

          override fun onError(e: CreateCredentialException) {
            val code = when {
              e is CreateCredentialCancellationException -> "cancelled"
              e is CreatePublicKeyCredentialDomException && e.domError is InvalidStateError -> "exists"
              e is CreatePublicKeyCredentialDomException && e.domError is NotAllowedError -> "cancelled"
              e is CreateCredentialProviderConfigurationException -> "unsupported"
              e is CreateCredentialUnsupportedException -> "unsupported"
              else -> "failed"
            }
            promise.reject(code, e.message ?: e.type, e)
          }
        },
      )
    }

    AsyncFunction("forget") { requestJson: String, promise: Promise ->
      signal(SignalUnknownCredentialRequest(requestJson), promise)
    }

    AsyncFunction("keepOnly") { requestJson: String, promise: Promise ->
      signal(SignalAllAcceptedCredentialIdsRequest(requestJson), promise)
    }

    AsyncFunction("get") { requestJson: String, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("failed", "No activity to show the passkey prompt on.", null)
        return@AsyncFunction
      }
      val manager = CredentialManager.create(activity)
      val request = GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson)))
      manager.getCredentialAsync(
        activity,
        request,
        CancellationSignal(),
        executor,
        object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
          override fun onResult(result: GetCredentialResponse) {
            val credential = result.credential
            if (credential is PublicKeyCredential) promise.resolve(credential.authenticationResponseJson)
            else promise.reject("failed", "Not a passkey.", null)
          }

          override fun onError(e: GetCredentialException) {
            val code = when {
              e is GetCredentialCancellationException -> "cancelled"
              e is NoCredentialException -> "none"
              e is GetPublicKeyCredentialDomException && e.domError is NotAllowedError -> "cancelled"
              e is GetCredentialProviderConfigurationException -> "unsupported"
              e is GetCredentialUnsupportedException -> "unsupported"
              else -> "failed"
            }
            promise.reject(code, e.message ?: e.type, e)
          }
        },
      )
    }
  }

  private fun signal(request: SignalCredentialStateRequest, promise: Promise) {
    val context = appContext.reactContext
    if (context == null) {
      promise.resolve(false)
      return
    }
    try {
      CredentialManager.create(context).signalCredentialStateAsync(
        request,
        executor,
        object : CredentialManagerCallback<SignalCredentialStateResponse, SignalCredentialStateException> {
          override fun onResult(result: SignalCredentialStateResponse) {
            promise.resolve(true)
          }

          override fun onError(e: SignalCredentialStateException) {
            promise.resolve(false)
          }
        },
      )
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }
}
