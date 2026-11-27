package com.whombat.live

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WhombatPushTest {
  @Test
  fun hiddenPreviewUsesEnglishCopy() {
    assertHiddenPreview("You were mentioned")
  }

  @Test
  fun hiddenPreviewUsesDutchCopy() {
    assertHiddenPreview("Je bent genoemd")
  }

  @Test
  fun managedPushDropsPrivateTextForBothFcmFlags() {
    val data = mapOf("kind" to "mention", "ref" to "opaque", "title" to "Private title", "body" to "Private body")
    for (flag in listOf("false", "0")) {
      val push = requireNotNull(ManagedPush.from(data + ("preview" to flag)))
      assertNull(push.title)
      assertNull(push.body)
      assertEquals("opaque", push.ref)
    }
    val allowed = requireNotNull(ManagedPush.from(data + ("preview" to "true")))
    assertEquals("Private title", allowed.title)
    assertEquals("Private body", allowed.body)
  }

  private fun assertHiddenPreview(genericBody: String) {
    val payload = JSONObject().put("kind", "mention").put("title", "Private title").put("body", "Private body")
    val strings = mapOf(R.string.whombat_notification_title to "Whombat", R.string.whombat_push_mention to genericBody)
    for (flag in listOf(false, "false", "0")) {
      payload.put("preview", flag)
      assertEquals("Whombat" to genericBody, WhombatPush.inboxText(payload, null, strings::getValue))
    }
    payload.put("preview", true)
    assertEquals("Whombat" to genericBody, WhombatPush.inboxText(payload, "false", strings::getValue))
    assertEquals("Private title" to "Private body", WhombatPush.inboxText(payload, null, strings::getValue))
  }
}
