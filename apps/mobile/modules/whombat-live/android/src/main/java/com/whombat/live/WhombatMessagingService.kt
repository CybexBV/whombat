package com.whombat.live

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Whombat's FCM messages are data-only: this service renders them itself, in the
 * foreground and in the background, so live activities keep updating while the app is closed. A new token
 * is handed to the app (`onPushToken`), which registers it with `devices.update`.
 */
class WhombatMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    WhombatPush.handle(applicationContext, message.data)
  }

  override fun onNewToken(token: String) {
    WhombatLiveModule.emitPushToken(token)
  }
}
