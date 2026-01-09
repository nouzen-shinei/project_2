package com.sneha.tution.keyboard

import android.content.ClipData
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Looper
import android.provider.OpenableColumns
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.core.view.ViewCompat
import androidx.core.view.inputmethod.EditorInfoCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.events.RCTEventEmitter
import com.facebook.react.views.textinput.ReactEditText
import java.io.File
import java.io.FileOutputStream

/**
 * React EditText that declares support for rich content (GIFs, images, stickers)
 * and forwards received content to JS via `onRichContent` event.
 */
class RichReactEditText(context: ReactContext) : ReactEditText(context) {

  private val supportedMimeTypes = arrayOf(
    "image/*",
    "image/gif",
    "image/webp",
    "video/*"
  )

  private var isApplyingJsText = false

  init {
    // Register a OnReceiveContent listener to capture content from keyboards
    ViewCompat.setOnReceiveContentListener(this, supportedMimeTypes) { _, payload ->
      try {
        val clip: ClipData? = payload.clip
        if (clip != null && clip.itemCount > 0) {
          val items = Arguments.createArray()
          for (i in 0 until clip.itemCount) {
            val item = clip.getItemAt(i)
            val uri: Uri? = item.uri
            if (uri != null) {
              val map = Arguments.createMap()
              map.putString("uri", uri.toString())
              // Determine mime from ClipData description or ContentResolver
              val desc = clip.description
              val descMime = if (desc.mimeTypeCount > 0) desc.getMimeType(0) else null
              val resolver = context.contentResolver
              val resolverMime = try { resolver.getType(uri) } catch (_: Throwable) { null }
              val mime = descMime ?: resolverMime
              if (mime != null) map.putString("mimeType", mime)

              // Try to copy the content to app cache for stable access
              try {
                val displayName = try {
                  var name: String? = null
                  val cursor = resolver.query(uri, null, null, null, null)
                  cursor?.use {
                    val nameIdx = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIdx != -1 && it.moveToFirst()) {
                      name = it.getString(nameIdx)
                    }
                  }
                  name
                } catch (_: Throwable) { null }

                val ext = when {
                  (mime ?: "").contains("png") -> "png"
                  (mime ?: "").contains("jpeg") || (mime ?: "").contains("jpg") -> "jpg"
                  (mime ?: "").contains("webp") -> "webp"
                  (mime ?: "").contains("gif") -> "gif"
                  else -> "bin"
                }
                val safeName = (displayName ?: "media_${System.currentTimeMillis()}.$ext")
                  .replace(Regex("[^a-zA-Z0-9._-]"), "_")
                val outFile = File(context.cacheDir, "kb_${safeName}")

                resolver.openInputStream(uri)?.use { input ->
                  FileOutputStream(outFile).use { output ->
                    input.copyTo(output)
                  }
                }
                map.putString("fileUri", Uri.fromFile(outFile).toString())
                map.putString("fileName", safeName)
              } catch (_: Throwable) {
                // Fallback: ignore cache copy failures
              }
              items.pushMap(map)
            }
          }

          val event = Arguments.createMap()
          event.putArray("items", items)
          (context as ReactContext)
            .getJSModule(RCTEventEmitter::class.java)
            .receiveEvent(id, "onRichContent", event)
        }
      } catch (_: Throwable) {
        // Ignore
      }
      // Return null to indicate we've handled all content
      null
    }
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val ic = super.onCreateInputConnection(outAttrs)
    // Advertise supported content types to IMEs (Gboard, SwiftKey, etc.)
    EditorInfoCompat.setContentMimeTypes(outAttrs, supportedMimeTypes)
    // For Android 13+, explicitly allow non-IME apps to insert rich content
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      outAttrs.setInitialSurroundingSubText("", 0)
    }
    return ic
  }

  /**
   * Forcefully clear any text (including composing text) and keep the keyboard open.
   * This resets the IME without blurring to avoid keyboard flicker.
   */
  fun forceClearAndRestartIme() {
    try {
      // Clear composing state via IMM and reset selection
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager

      // Replace text with empty and move cursor to start
      setText("")
      setSelection(0)

      // Ask IME to restart its connection to this view, which drops any composing text
      imm?.restartInput(this)
      // Explicitly notify selection changed to 0,0 and no composing (-1,-1)
      imm?.updateSelection(this, 0, 0, -1, -1)
    } catch (_: Throwable) {
      // Best-effort; ignore errors
    }
  }

  fun applyTextFromJs(text: String) {
    if (isApplyingJsText) {
      return
    }

    val current = this.text?.toString() ?: ""
    if (current == text) {
      return
    }

    if (Looper.myLooper() != Looper.getMainLooper()) {
      post { applyTextFromJs(text) }
      return
    }

    isApplyingJsText = true
    try {
      setText(text)
      val length = text.length.coerceAtLeast(0)
      setSelection(length)
    } finally {
      isApplyingJsText = false
    }
  }
}
