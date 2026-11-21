import AuthenticationServices
import CryptoKit
import ExpoModulesCore
import UIKit

/**
 * `WhombatPasskeys` (iOS): passkeys through AuthenticationServices, WebAuthn JSON in and JSON out like the Android
 * module (docs/app/decisions/ios-parity.md AP-6320). The request is the options JSON control sends
 * (`PublicKeyCredentialCreationOptionsJSON` / `…RequestOptionsJSON`), the answer the `RegistrationResponseJSON` /
 * `AuthenticationResponseJSON` the Whombat and control verify. The origin is `https://<RP ID>`, the hosted UI's, which
 * the UI's `/.well-known/apple-app-site-association` ties to this app (`webcredentials`). A passkey on another device
 * can sign in too: iOS offers its QR code itself.
 *
 * Rejections carry the codes the app tells apart: `cancelled` (dismissed), `exists` (this phone already holds a
 * passkey for the Whombat), `unsupported` (the app isn't tied to the RP ID), `failed`. `forget` and `keepOnly` never
 * reject.
 */
public final class WhombatPasskeysModule: Module {
  /** The request on screen; iOS shows one at a time, and the controller holds its delegate weakly. */
  private var ongoing: PasskeyRequest?

  public func definition() -> ModuleDefinition {
    Name("WhombatPasskeys")

    Function("isSupported") { () -> Bool in true }

    // WebAuthn's PRF extension (the passkey as the key to the backups; AP-6855, AP-6869): iOS 18 and later, on get and
    // at creation.
    Function("supportsPrf") { () -> Bool in
      if #available(iOS 18.0, *) { return true }
      return false
    }

    AsyncFunction("create") { (requestJson: String, promise: Promise) in
      self.perform(promise) { try registration(requestJson) }
    }.runOnQueue(.main)

    AsyncFunction("get") { (requestJson: String, promise: Promise) in
      self.perform(promise) { try assertion(requestJson) }
    }.runOnQueue(.main)

    // WebAuthn's Signal API requests (`{rpId, credentialId}`, `{rpId, userId, allAcceptedCredentialIds}`), passed to
    // the passkey provider so it stops offering passkeys whose Whombat is gone. They show nothing and always resolve
    // (false where iOS is older than 26.2 or the provider can't): nothing for the person to be told.
    AsyncFunction("forget") { (requestJson: String, promise: Promise) in
      guard #available(iOS 26.2, *),
        let request = try? object(requestJson),
        let rpId = request["rpId"] as? String,
        let credentialID = try? bytes(request["credentialId"], "credentialId")
      else { return promise.resolve(false) }
      Task {
        do {
          try await ASCredentialDataManager().reportUnknownPublicKeyCredential(
            relyingPartyIdentifier: rpId, credentialID: credentialID)
          promise.resolve(true)
        } catch {
          promise.resolve(false)
        }
      }
    }

    AsyncFunction("keepOnly") { (requestJson: String, promise: Promise) in
      guard #available(iOS 26.2, *),
        let request = try? object(requestJson),
        let rpId = request["rpId"] as? String,
        let userHandle = try? bytes(request["userId"], "userId"),
        let ids = request["allAcceptedCredentialIds"] as? [String]
      else { return promise.resolve(false) }
      let accepted = ids.compactMap { Data(base64URL: $0) }
      Task {
        do {
          try await ASCredentialDataManager().reportAllAcceptedPublicKeyCredentials(
            relyingPartyIdentifier: rpId, userHandle: userHandle, acceptedCredentialIDs: accepted)
          promise.resolve(true)
        } catch {
          promise.resolve(false)
        }
      }
    }
  }

  private func perform(_ promise: Promise, _ make: () throws -> ASAuthorizationRequest) {
    let request: ASAuthorizationRequest
    do {
      request = try make()
    } catch {
      promise.reject("failed", "\(error)")
      return
    }
    ongoing?.finish(code: "cancelled", message: "Another passkey request took its place.")
    let pending = PasskeyRequest(promise: promise) { [weak self] done in
      if self?.ongoing === done { self?.ongoing = nil }
    }
    ongoing = pending
    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = pending
    controller.presentationContextProvider = pending
    controller.performRequests()
  }
}

private struct OptionsError: Error, CustomStringConvertible {
  let description: String
}

private func object(_ json: String) throws -> [String: Any] {
  guard let data = json.data(using: .utf8),
    let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { throw OptionsError(description: "The passkey options aren't a JSON object.") }
  return value
}

private func bytes(_ value: Any?, _ name: String) throws -> Data {
  guard let text = value as? String, let data = Data(base64URL: text) else {
    throw OptionsError(description: "The passkey options have no \(name).")
  }
  return data
}

private func verification(_ value: Any?) -> ASAuthorizationPublicKeyCredentialUserVerificationPreference {
  switch value as? String {
  case "required": return .required
  case "discouraged": return .discouraged
  default: return .preferred
  }
}

private func descriptors(_ value: Any?) -> [ASAuthorizationPlatformPublicKeyCredentialDescriptor] {
  ((value as? [[String: Any]]) ?? []).compactMap { entry in
    (entry["id"] as? String).flatMap { Data(base64URL: $0) }.map {
      ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
    }
  }
}

private func registration(_ json: String) throws -> ASAuthorizationRequest {
  let options = try object(json)
  let rp = options["rp"] as? [String: Any]
  let user = options["user"] as? [String: Any]
  guard let rpId = rp?["id"] as? String, let name = user?["name"] as? String else {
    throw OptionsError(description: "The passkey options name no RP ID or user.")
  }
  let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
  let request = provider.createCredentialRegistrationRequest(
    challenge: try bytes(options["challenge"], "challenge"),
    name: name,
    userID: try bytes(user?["id"], "user id")
  )
  if let displayName = user?["displayName"] as? String, !displayName.isEmpty {
    request.displayName = displayName
  }
  let selection = options["authenticatorSelection"] as? [String: Any]
  request.userVerificationPreference = verification(selection?["userVerification"])
  switch options["attestation"] as? String {
  case "direct": request.attestationPreference = .direct
  case "indirect": request.attestationPreference = .indirect
  case "enterprise": request.attestationPreference = .enterprise
  default: request.attestationPreference = .none
  }
  if #available(iOS 17.4, *) {
    request.excludedCredentials = descriptors(options["excludeCredentials"])
  }
  // `extensions.prf` at creation (iOS 18 and later): with `eval` the new passkey answers the salt's secret in the same
  // touch, so adding it also makes it the key to the backups (Whombat backup-passkey.md BPK-02); without one, iOS only
  // says whether it can. Older iOS leaves PRF out, and the next touch arms it.
  if #available(iOS 18.0, *),
    let extensions = options["extensions"] as? [String: Any],
    let prf = extensions["prf"] as? [String: Any]
  {
    if let eval = prf["eval"] as? [String: Any],
      let first = (eval["first"] as? String).flatMap({ Data(base64URL: $0) })
    {
      let second = (eval["second"] as? String).flatMap { Data(base64URL: $0) }
      request.prf = .inputValues(
        ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: first, saltInput2: second))
    } else {
      request.prf = .checkForSupport
    }
  }
  return request
}

private func assertion(_ json: String) throws -> ASAuthorizationRequest {
  let options = try object(json)
  guard let rpId = options["rpId"] as? String else {
    throw OptionsError(description: "The passkey options name no RP ID.")
  }
  let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
  let request = provider.createCredentialAssertionRequest(challenge: try bytes(options["challenge"], "challenge"))
  request.allowedCredentials = descriptors(options["allowCredentials"])
  request.userVerificationPreference = verification(options["userVerification"])
  // `extensions.prf.eval` (WebAuthn's PRF): the passkey answers a secret for the salt, which locks the recovery kit.
  if #available(iOS 18.0, *),
    let extensions = options["extensions"] as? [String: Any],
    let prf = extensions["prf"] as? [String: Any],
    let eval = prf["eval"] as? [String: Any],
    let first = (eval["first"] as? String).flatMap({ Data(base64URL: $0) })
  {
    let second = (eval["second"] as? String).flatMap { Data(base64URL: $0) }
    request.prf = .inputValues(
      ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: first, saltInput2: second))
  }
  return request
}

/** One request on screen: answers its promise once, with the WebAuthn JSON or a code. */
private final class PasskeyRequest: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  private var promise: Promise?
  private let done: (PasskeyRequest) -> Void

  init(promise: Promise, done: @escaping (PasskeyRequest) -> Void) {
    self.promise = promise
    self.done = done
  }

  func finish(json: [String: Any]) {
    guard let promise else { return }
    self.promise = nil
    done(self)
    guard let data = try? JSONSerialization.data(withJSONObject: json),
      let text = String(data: data, encoding: .utf8)
    else {
      promise.reject("failed", "The passkey's answer couldn't be written as JSON.")
      return
    }
    promise.resolve(text)
  }

  func finish(code: String, message: String) {
    guard let promise else { return }
    self.promise = nil
    done(self)
    promise.reject(code, message)
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
    return windows.first { $0.isKeyWindow } ?? windows.first ?? ASPresentationAnchor()
  }

  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    if let made = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
      let id = made.credentialID.base64URL
      // PRF at creation, as WebAuthn's JSON has it: `enabled`, and the salt's secret when the passkey answered it.
      var extensionResults: [String: Any] = [:]
      if #available(iOS 18.0, *), let prf = made.prf {
        var out: [String: Any] = ["enabled": prf.isSupported]
        if let first = prf.first {
          var results: [String: Any] = ["first": first.withUnsafeBytes { Data($0) }.base64URL]
          if let second = prf.second { results["second"] = second.withUnsafeBytes { Data($0) }.base64URL }
          out["results"] = results
        }
        extensionResults["prf"] = out
      }
      finish(json: [
        "id": id,
        "rawId": id,
        "type": "public-key",
        "authenticatorAttachment": "platform",
        "response": [
          "clientDataJSON": made.rawClientDataJSON.base64URL,
          "attestationObject": (made.rawAttestationObject ?? Data()).base64URL,
          "transports": ["hybrid", "internal"],
        ],
        "clientExtensionResults": extensionResults,
      ])
    } else if let used = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
      let id = used.credentialID.base64URL
      var response: [String: Any] = [
        "clientDataJSON": used.rawClientDataJSON.base64URL,
        "authenticatorData": used.rawAuthenticatorData.base64URL,
        "signature": used.signature.base64URL,
      ]
      if !used.userID.isEmpty { response["userHandle"] = used.userID.base64URL }
      var extensionResults: [String: Any] = [:]
      if #available(iOS 18.0, *), let prf = used.prf {
        var results: [String: Any] = ["first": prf.first.withUnsafeBytes { Data($0) }.base64URL]
        if let second = prf.second { results["second"] = second.withUnsafeBytes { Data($0) }.base64URL }
        extensionResults["prf"] = ["results": results]
      }
      finish(json: [
        "id": id,
        "rawId": id,
        "type": "public-key",
        "authenticatorAttachment": "platform",
        "response": response,
        "clientExtensionResults": extensionResults,
      ])
    } else {
      finish(code: "failed", message: "Not a passkey.")
    }
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    let code: String
    switch (error as? ASAuthorizationError)?.code {
    case .canceled: code = "cancelled"
    case .notHandled: code = "unsupported"
    default:
      if #available(iOS 18.0, *), (error as? ASAuthorizationError)?.code == .matchedExcludedCredential {
        code = "exists"
      } else {
        code = "failed"
      }
    }
    finish(code: code, message: error.localizedDescription)
  }
}

extension Data {
  /** base64url without padding, as WebAuthn's JSON has it. */
  fileprivate var base64URL: String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  fileprivate init?(base64URL text: String) {
    var plain = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    plain += String(repeating: "=", count: (4 - plain.count % 4) % 4)
    self.init(base64Encoded: plain)
  }
}
