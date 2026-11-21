package com.whombat.transfer

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.WindowManager
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.Serializable

/** What “Save as” starts with: the file's name and its type. */
internal data class CreateDocumentInput(val name: String, val mimeType: String) : Serializable

/**
 * Android's own “Save as” (`ACTION_CREATE_DOCUMENT`): the person picks the folder or the drive (Downloads included,
 * which a folder picker can't offer since Android 11) and may change the name; the answer is the new document's
 * `content://` URI, or null when they backed out.
 */
internal class CreateDocumentContract : AppContextActivityResultContract<CreateDocumentInput, Uri?> {
  override fun createIntent(context: Context, input: CreateDocumentInput): Intent =
    Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = input.mimeType
      putExtra(Intent.EXTRA_TITLE, input.name)
    }

  override fun parseResult(input: CreateDocumentInput, resultCode: Int, intent: Intent?): Uri? =
    if (resultCode == Activity.RESULT_OK) intent?.data else null
}

/**
 * `WhombatTransfer` (Android): moving a big file to or from the phone (backup-file-android.md AP-1214, AP-1215).
 * `createDocument` asks where to save a file and answers the document Android made for it; the JavaScript side writes
 * the bytes into it as they arrive (expo-file-system's file handle on the `content://` URI), so the file is never held
 * whole. `keepScreenOn` keeps the screen on while a transfer runs, so the phone doesn't sleep and pause it. The
 * JavaScript side is `modules/whombat-transfer/index.ts`.
 */
class WhombatTransferModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WhombatTransfer")

    lateinit var saveAs: AppContextActivityResultLauncher<CreateDocumentInput, Uri?>

    RegisterActivityContracts {
      saveAs = registerForActivityResult(CreateDocumentContract())
    }

    Function("isSupported") { true }

    /** Opens “Save as” with `name`; resolves with the new document's URI, or null when the person backed out. */
    AsyncFunction("createDocument") Coroutine { name: String, mimeType: String ->
      val uri = saveAs.launch(CreateDocumentInput(name, mimeType))
      if (uri != null) {
        // Kept for the length of the download, even if Android recreates the activity meanwhile.
        runCatching {
          appContext.reactContext?.contentResolver?.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
          )
        }
      }
      uri?.toString()
    }

    /** Keeps the screen on (or lets it sleep again); false when there is no activity to ask. */
    Function("keepScreenOn") { on: Boolean ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread {
        if (on) {
          activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
          activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
      true
    }
  }
}
